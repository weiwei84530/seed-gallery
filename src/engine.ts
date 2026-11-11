import { addJobs, changed, database, getMedia, mediaRecord, saveJob } from './db';
import { buildRequest, validateDraft } from './models';
import {
  ApiError,
  blobDataUri,
  friendlyError,
  isConflictError,
  isCreditError,
  keyTag,
  request,
  resultBlob,
  videoBlob,
  type ApiResponse,
} from './runware';
import { isVideo, type Draft, type Job } from './types';

const running = new Set<string>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasCreditFailure(job: Job) {
  return (
    job.failureReason === 'credits' ||
    job.message === friendlyError('insufficientCredits') ||
    job.message === '服務帳戶目前無法生成，請至 Runware 檢查帳戶狀態。'
  );
}

export async function queueGeneration(workId: string, draft: Draft, key: string) {
  validateDraft(draft);
  const tag = await keyTag(key);
  const batchId = crypto.randomUUID();
  const jobs = draft.models.flatMap((model) =>
    Array.from({ length: draft.count }, (): Job => ({
      id: crypto.randomUUID(),
      workId,
      batchId,
      model,
      status: 'queued',
      createdAt: Date.now(),
      draft: structuredClone(draft),
      keyTag: tag,
    })),
  );
  await addJobs(jobs);
  for (const job of jobs) void runJob(job.id, key, true);
}

async function handleResponse(
  job: Job,
  response: ApiResponse,
  submitting = false,
): Promise<boolean> {
  const item = response.data?.find(
    (i) =>
      i.taskUUID === job.id &&
      i.status !== 'error' &&
      (isVideo(job.draft) ? i.videoURL : i.imageDataURI || i.imageBase64Data || i.imageURL),
  );
  if (item) {
    try {
      const blob = await (isVideo(job.draft) ? videoBlob(item) : resultBlob(item));
      const record = await mediaRecord({
        id: job.id,
        blob,
        name: `${job.model}-${job.id}.${isVideo(job.draft) ? 'mp4' : 'png'}`,
      });
      const tx = (await database).transaction(['jobs', 'media'], 'readwrite');
      void tx.done.catch(() => {});
      // A deletion in another tab must not recreate an orphan result.
      if (await tx.objectStore('jobs').get(job.id)) {
        await tx.objectStore('media').put(record);
        await tx.objectStore('jobs').put({
          ...job,
          status: 'succeeded',
          mediaId: job.id,
          message: undefined,
          cost:
            typeof item.cost === 'number' && Number.isFinite(item.cost) && item.cost >= 0
              ? item.cost
              : undefined,
        });
      }
      await tx.done;
      changed();
    } catch {
      await saveJob({
        ...job,
        status: 'retrieval_failed',
        message: `${isVideo(job.draft) ? '影片' : '圖片'}已生成，但下載或保存失敗。請查詢原任務重試，不會重新生成。`,
      });
    }
    return true;
  }
  const failedItem = response.data?.find((i) => i.taskUUID === job.id && i.status === 'error');
  const error =
    response.errors?.find((i) => i.taskUUID === job.id) ??
    (failedItem ? { ...failedItem, code: failedItem.error?.code } : undefined) ??
    (submitting ? response.errors?.[0] : undefined);
  if (error) {
    // Only an explicit generation error is safe to offer as a paid retry.
    const terminal =
      ((error.status === 'error' || (!submitting && error.taskUUID === job.id)) &&
        !/notfound|not.?found|not.?ready/i.test(error.code ?? '')) ||
      (submitting &&
        /invalid|insufficient|unauthorized|forbidden|moderation|rateLimit/i.test(error.code ?? ''));
    await saveJob({
      ...job,
      status: terminal ? 'failed' : 'unknown',
      message: friendlyError(error.code),
      failureReason: isCreditError(error.code) ? 'credits' : undefined,
    });
    return true;
  }
  const completed = response.data?.find((i) => i.taskUUID === job.id && i.status === 'success');
  if (completed) {
    await saveJob({
      ...job,
      status: 'retrieval_failed',
      message: `${isVideo(job.draft) ? '影片' : '圖片'}已完成，但服務未提供可下載的檔案。請查詢原任務重試。`,
    });
    return true;
  }
  if (response.errors?.length) throw new ApiError(response.errors[0].code ?? 'unknown');
  return false;
}

// Runware rejects a reused taskUUID with conflictTaskUUID, so resending an
// unacknowledged submission cannot start a second paid task within this window.
const RESUBMIT_WINDOW = 60 * 60 * 1000;

async function referenceUris(job: Job) {
  return Promise.all(
    job.draft.refs.map(async (ref) => {
      const media = await getMedia(ref);
      if (!media) throw new Error('參考照片已遺失，請重新選擇照片。');
      return blobDataUri(media.blob);
    }),
  );
}

// Returns the acknowledged job, or undefined when the job reached a final state.
async function submit(job: Job, key: string, payload: object): Promise<Job | undefined> {
  let response: ApiResponse;
  try {
    response = await request(key, payload);
  } catch (error) {
    if (error instanceof ApiError && !isConflictError(error.code)) {
      await saveJob({
        ...job,
        status: 'failed',
        message: error.message,
        failureReason: isCreditError(error.code) ? 'credits' : undefined,
      });
      return;
    }
    if (!(error instanceof ApiError)) throw error;
    response = { data: [] };
  }
  const accepted: Job = { ...job, submission: 'accepted' };
  // A conflict proves that an earlier attempt with this taskUUID reached Runware.
  if (response.errors?.some((item) => isConflictError(item.code))) return accepted;
  await saveJob(accepted);
  if (await handleResponse(accepted, response, true)) return;
  return accepted;
}

export async function runJob(id: string, key: string, allowSubmit = false) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const execute = async () => {
      const db = await database;
      let job = await db.get('jobs', id);
      if (
        !job ||
        ['succeeded', 'failed'].includes(job.status) ||
        job.keyTag !== (await keyTag(key))
      )
        return;
      try {
        if (job.status === 'queued' && allowSubmit) {
          const payload = buildRequest(job.id, job.model, job.draft, await referenceUris(job));
          const tx = db.transaction('jobs', 'readwrite');
          const current = await tx.store.get(id);
          if (!current || current.status !== 'queued') {
            await tx.done;
            return;
          }
          job = { ...current, status: 'sending', submission: 'pending' };
          await tx.store.put(job);
          await tx.done;
          changed();
          const accepted = await submit(job, key, payload);
          if (!accepted) return;
          job = accepted;
        } else if (job.status === 'queued') {
          await saveJob({ ...job, status: 'failed', message: '這份作品尚未送出，可以重新生成。' });
          return;
        } else if (job.submission === 'pending') {
          // The first attempt timed out or lost its connection before Runware answered.
          // getResponse reports "processing" even for unknown tasks, so polling alone
          // could wait forever; resending the same taskUUID settles it safely.
          if (Date.now() - job.createdAt > RESUBMIT_WINDOW) {
            await saveJob({
              ...job,
              status: 'failed',
              message: '無法確認這次是否已送出，Runware 也沒有結果。可以重新生成，會另外計費。',
            });
            return;
          }
          const payload = buildRequest(job.id, job.model, job.draft, await referenceUris(job));
          job = { ...job, status: 'sending', message: undefined };
          await saveJob(job);
          const accepted = await submit(job, key, payload);
          if (!accepted) return;
          job = accepted;
        }
        job = { ...job, status: 'processing', message: undefined };
        await saveJob(job);
        const deadline = job.createdAt + (isVideo(job.draft) ? 15 : 5) * 60 * 1000;
        let delay = 1800;
        let interrupted = false;
        do {
          if (Date.now() < deadline) await wait(delay);
          if (!(await db.get('jobs', id))) return;
          delay = Math.min(delay * 1.5, 12000);
          if (!navigator.onLine) {
            interrupted = true;
            continue;
          }
          let response: ApiResponse;
          try {
            response = await request(key, { taskType: 'getResponse', taskUUID: id }, 120000);
          } catch (error) {
            // getResponse reports a failed task (e.g. provider moderation) as HTTP 400.
            if (error instanceof ApiError && error.response?.errors?.length) {
              if (await handleResponse(job, error.response)) return;
            }
            // A slow or dropped poll does not change the task; keep polling until the deadline.
            if (error instanceof ApiError) throw error;
            interrupted = true;
            continue;
          }
          interrupted = false;
          if (await handleResponse(job, response)) return;
        } while (Date.now() < deadline);
        await saveJob({
          ...job,
          status: 'unknown',
          message: interrupted
            ? '連線暫時中斷，請查詢原任務。查詢不會重新生成。'
            : '等待時間較長，可稍後查詢原任務。',
        });
      } catch (error) {
        const current = await db.get('jobs', id);
        if (!current || current.status === 'succeeded') return;
        await saveJob({
          ...current,
          status: current.status === 'queued' ? 'failed' : 'unknown',
          message:
            error instanceof ApiError
              ? error.message
              : '連線或保存暫時中斷，請查詢原任務。查詢不會重新生成。',
        });
      }
    };
    if (navigator.locks)
      await navigator.locks.request(
        `img-generator.job.${id}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await execute();
        },
      );
    else await execute();
  } finally {
    running.delete(id);
  }
}

export async function resumeJobs(key: string) {
  const tag = await keyTag(key);
  const jobs = await (await database).getAll('jobs');
  for (const job of jobs)
    if (job.keyTag === tag && ['queued', 'sending', 'processing', 'unknown'].includes(job.status))
      void runJob(job.id, key);
}
