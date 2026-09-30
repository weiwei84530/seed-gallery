import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { clearWorks, database } from '../src/db';
import { runJob } from '../src/engine';
import { keyTag } from '../src/runware';
import { newVideoDraft, type Job } from '../src/types';

const key = 'test-key';

async function pendingVideo(): Promise<Job> {
  const job: Job = {
    id: crypto.randomUUID(),
    workId: crypto.randomUUID(),
    batchId: crypto.randomUUID(),
    model: 'seedance',
    status: 'processing',
    createdAt: Date.now(),
    draft: { ...newVideoDraft(), models: ['seedance'], prompt: 'A paper boat' },
    keyTag: await keyTag(key),
  };
  await (await database).put('jobs', job);
  return job;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearWorks();
});

it('marks a polled provider failure as failed instead of leaving a video processing', async () => {
  const job = await pendingVideo();
  vi.stubGlobal('navigator', { onLine: true });
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      errors: [{ taskUUID: job.id, code: 'timeoutProvider', status: 'error' }],
    })),
  );
  vi.stubGlobal('fetch', fetch);

  await runJob(job.id, key);

  expect((await (await database).get('jobs', job.id))?.status).toBe('failed');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('shows a completed video download failure and retries the original task only', async () => {
  const job = await pendingVideo();
  vi.stubGlobal('navigator', { onLine: true });
  const fetch = vi.fn(async (input: string, _init?: RequestInit) =>
    input === 'https://api.runware.ai/v1'
      ? new Response(JSON.stringify({
          data: [{ taskUUID: job.id, status: 'success', videoURL: 'https://vm.runware.ai/video.mp4' }],
        }))
      : new Response('missing', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetch);

  await runJob(job.id, key);
  const failed = await (await database).get('jobs', job.id);
  expect(failed?.status).toBe('retrieval_failed');
  expect(failed?.message).toContain('下載或保存失敗');

  await runJob(job.id, key);
  const tasks = fetch.mock.calls
    .filter(([input]) => input === 'https://api.runware.ai/v1')
    .map(([, init]) => JSON.parse(String(init?.body))[0]);
  expect(tasks).toEqual([
    { taskType: 'getResponse', taskUUID: job.id },
    { taskType: 'getResponse', taskUUID: job.id },
  ]);
});

it('checks an old processing task once after reopening, then stops the spinner', async () => {
  const job = await pendingVideo();
  await (await database).put('jobs', { ...job, createdAt: Date.now() - 16 * 60 * 1000 });
  vi.stubGlobal('navigator', { onLine: true });
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [{ taskUUID: job.id, status: 'processing' }] })),
  );
  vi.stubGlobal('fetch', fetch);

  await runJob(job.id, key);

  expect((await (await database).get('jobs', job.id))?.status).toBe('unknown');
  expect(fetch).toHaveBeenCalledTimes(1);
});
