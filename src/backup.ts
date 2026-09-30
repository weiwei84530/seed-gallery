import { unzip, zip, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import { asMedia, changed, chatMediaIds, database, mediaRecord } from './db';
import type { Job, Media, Work } from './types';
import type { ChatAttachment, ChatSession } from './chat-types';
import { chatModelIds } from './chat-types';
import { modelIds } from './types';
import { draftSchema } from './draft-schema';
import { models } from './models';
import { initialPreferences, savePreferences } from './preferences';

const id = z.string().uuid();
const workSchema = z.object({
  id,
  title: z.string().max(100),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  draft: draftSchema,
});
const jobSchema = z.object({
  id,
  workId: id,
  batchId: id,
  model: z.enum(modelIds),
  createdAt: z.number().finite(),
  draft: draftSchema,
  status: z.enum([
    'queued',
    'sending',
    'processing',
    'unknown',
    'retrieval_failed',
    'failed',
    'succeeded',
  ]),
  mediaId: id.optional(),
  cost: z.number().nonnegative().finite().optional(),
});
const attachmentSchema = z.object({
  id,
  name: z.string().max(255),
  type: z.string().max(120),
  size: z.number().int().nonnegative().finite(),
  text: z.string().max(2_000_000).optional(),
  imageIds: z.array(id).max(100),
});
const sourceSchema = z.object({
  title: z.string().max(1000),
  url: z
    .string()
    .url()
    .max(4000)
    .refine((url) => ['https:', 'http:'].includes(new URL(url).protocol)),
});
const historySchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
  attachments: z.array(attachmentSchema).max(20).optional(),
  sources: z.array(sourceSchema).max(100).optional(),
  author: z.string().max(100).optional(),
});
const answerSchema = z.object({
  id,
  taskUUID: id,
  text: z.string().max(200_000),
  status: z.enum(['queued', 'streaming', 'complete', 'stopped', 'failed', 'interrupted']),
  sources: z.array(sourceSchema).max(100),
  cost: z.number().nonnegative().finite().optional(),
  error: z.string().max(5000).optional(),
  createdAt: z.number().finite(),
});
const turnSchema = z
  .object({
    id,
    text: z.string().max(100_000),
    attachments: z.array(attachmentSchema).max(20),
    search: z.boolean(),
    createdAt: z.number().finite(),
    answers: z.partialRecord(z.enum(chatModelIds), z.array(answerSchema).max(20)),
    selectedAnswers: z.partialRecord(z.enum(chatModelIds), id),
  })
  .superRefine((turn, context) => {
    for (const [model, selected] of Object.entries(turn.selectedAnswers)) {
      if (
        !turn.answers[model as keyof typeof turn.answers]?.some((answer) => answer.id === selected)
      )
        context.addIssue({ code: 'custom', message: 'Selected answer is missing' });
    }
  });
const chatSchema = z
  .object({
    id,
    title: z.string().max(100),
    models: z
      .array(z.enum(chatModelIds))
      .min(1)
      .max(3)
      .refine((models) => new Set(models).size === models.length),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    seed: z.array(historySchema).max(10000),
    turns: z.array(turnSchema).max(300),
    draft: z.string().max(100_000),
    draftAttachments: z.array(attachmentSchema).max(20),
    search: z.boolean(),
    fork: z.object({ sessionId: id, model: z.enum(chatModelIds), turnId: id }).optional(),
  })
  .superRefine((session, context) => {
    if (new Set(session.turns.map((turn) => turn.id)).size !== session.turns.length)
      context.addIssue({ code: 'custom', message: 'Duplicate turn IDs' });
    const answers = session.turns.flatMap((turn) => Object.values(turn.answers).flat());
    if (new Set(answers.map((answer) => answer.id)).size !== answers.length)
      context.addIssue({ code: 'custom', message: 'Duplicate answer IDs' });
  });
const manifestSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    works: z.array(workSchema).max(10000),
    jobs: z.array(jobSchema).max(50000),
    chats: z.array(chatSchema).max(10000).optional(),
    chatSettings: z.object({ systemPrompt: z.string().max(12000) }).optional(),
    media: z
      .array(
        z.object({
          id,
          type: z.enum([
            'image/png',
            'image/jpeg',
            'image/webp',
            'video/mp4',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
          ]),
          name: z.string().max(255),
        }),
      )
      .max(50000),
  })
  .superRefine((manifest, context) => {
    if (manifest.version === 3 && !manifest.chats)
      context.addIssue({ code: 'custom', message: 'Chats are required in version 3' });
  });
export async function exportBackup(): Promise<Blob> {
  const tx = (await database).transaction(['works', 'jobs', 'media', 'chats']);
  const [works, jobs, media, chats] = await Promise.all([
    tx.objectStore('works').getAll(),
    tx.objectStore('jobs').getAll(),
    tx.objectStore('media').getAll(),
    tx.objectStore('chats').getAll(),
  ]);
  await tx.done;
  const used = new Set([
    ...works.flatMap((w) => w.draft.refs),
    ...jobs.flatMap((j) => [...j.draft.refs, j.mediaId ?? '']),
    ...chats.flatMap(chatMediaIds),
  ]);
  const selected = media.filter((m) => used.has(m.id)).map(asMedia);
  const manifest = {
    version: 3,
    works,
    jobs: jobs.map(({ keyTag: _tag, message: _message, ...job }) => job),
    chats,
    chatSettings: {
      systemPrompt:
        typeof localStorage === 'undefined'
          ? ''
          : (initialPreferences(localStorage.getItem('img-generator.preferences'), '')
              .chatSystemPrompt ?? ''),
    },
    media: selected.map(({ id, blob, name }) => ({ id, type: blob.type, name })),
  };
  const manifestBytes = strToU8(JSON.stringify(manifest));
  if (
    manifestBytes.byteLength > 100 * 1024 * 1024 ||
    selected.reduce((size, item) => size + item.blob.size, manifestBytes.byteLength) >
      240 * 1024 * 1024
  )
    throw new Error('作品超過單次備份容量，請先下載重要作品並分批整理。');
  const files: Record<string, Uint8Array> = { 'manifest.json': manifestBytes };
  for (const m of selected) files[`media/${m.id}`] = new Uint8Array(await m.blob.arrayBuffer());
  const zipped = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) =>
    zip(files, { level: 0 }, (error, data) =>
      error ? reject(error) : resolve(new Uint8Array(data)),
    ),
  );
  return new Blob([zipped], { type: 'application/zip' });
}
export async function importBackup(file: File) {
  if (file.size > 250 * 1024 * 1024) throw new Error('可還原 250 MB 以內的備份。');
  let total = 0;
  let tooLarge = false;
  // Read the archive with an uncompressed-size guard before allocating entries.
  const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    void file
      .arrayBuffer()
      .then((buffer) =>
        unzip(
          new Uint8Array(buffer),
          {
            filter: (entry) => {
              total += entry.originalSize;
              if (entry.originalSize > 100 * 1024 * 1024 || total > 500 * 1024 * 1024) {
                tooLarge = true;
                return false;
              }
              return entry.name === 'manifest.json' || /^media\/[0-9a-f-]{36}$/.test(entry.name);
            },
          },
          (error, data) => (error ? reject(new Error('備份檔案無法讀取。')) : resolve(data)),
        ),
      )
      .catch(reject);
  });
  if (tooLarge || !extracted['manifest.json']) throw new Error('備份過大或缺少作品清單。');
  const parsed = manifestSchema.safeParse(JSON.parse(strFromU8(extracted['manifest.json'])));
  if (!parsed.success) throw new Error('這不是支援的種子畫廊備份格式。');
  const data = parsed.data;
  const chats = data.chats ?? [];
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(data.works.map((work) => work.id)) ||
    !unique(data.jobs.map((job) => job.id)) ||
    !unique(data.media.map((item) => item.id)) ||
    !unique(chats.map((chat) => chat.id))
  )
    throw new Error('備份含有重複的資料 ID。');
  const remap = new Map<string, string>();
  const mapId = (old: string) => {
    if (!remap.has(old)) remap.set(old, crypto.randomUUID());
    return remap.get(old)!;
  };
  const media: Media[] = data.media.map((m) => {
    const bytes = extracted[`media/${m.id}`];
    if (!bytes?.length) throw new Error('備份缺少媒體檔案，尚未匯入任何作品。');
    return {
      id: mapId(m.id),
      name: m.name,
      blob: new Blob([new Uint8Array(bytes)], { type: m.type }),
    };
  });
  const mediaIds = new Set(data.media.map((m) => m.id));
  const mediaTypes = new Map(data.media.map((m) => [m.id, m.type]));
  const workIds = new Set(data.works.map((w) => w.id));
  for (const session of chats) {
    const attachments = [
      ...session.seed.flatMap((message) => message.attachments ?? []),
      ...session.turns.flatMap((turn) => turn.attachments),
      ...session.draftAttachments,
    ];
    for (const attachment of attachments) {
      if (!mediaIds.has(attachment.id)) throw new Error('備份中的對話原始附件不存在。');
      if (attachment.imageIds.some((ref) => !mediaTypes.get(ref)?.startsWith('image/')))
        throw new Error('備份中的對話圖片不存在或格式不符。');
    }
  }
  for (const d of [...data.works.map((w) => w.draft), ...data.jobs.map((j) => j.draft)]) {
    if (d.refs.some((ref) => !mediaTypes.get(ref)?.startsWith('image/')))
      throw new Error('備份缺少參考照片或照片格式不符。');
    if (d.models.some((model) => models[model].kind !== (d.kind ?? 'image')))
      throw new Error('備份中的模型與作品類別不符。');
  }
  for (const j of data.jobs)
    if (
      !workIds.has(j.workId) ||
      models[j.model].kind !== (j.draft.kind ?? 'image') ||
      (j.mediaId && !mediaIds.has(j.mediaId)) ||
      (j.mediaId && (mediaTypes.get(j.mediaId) === 'video/mp4') !== (j.draft.kind === 'video')) ||
      (j.status === 'succeeded' && !j.mediaId)
    )
      throw new Error('備份作品資料不完整。');
  const works: Work[] = data.works.map((w) => ({
    ...w,
    id: mapId(w.id),
    draft: { ...w.draft, refs: w.draft.refs.map(mapId) },
  }));
  const jobs: Job[] = data.jobs.map((j) => ({
    ...j,
    id: mapId(j.id),
    workId: mapId(j.workId),
    batchId: mapId(j.batchId),
    draft: { ...j.draft, refs: j.draft.refs.map(mapId) },
    mediaId: j.mediaId ? mapId(j.mediaId) : undefined,
    keyTag: '',
    status: j.status === 'succeeded' ? 'succeeded' : 'unknown',
    message: '此為備份中的未完成紀錄，不會自動重新生成。',
  }));
  const remapAttachment = (attachment: ChatAttachment): ChatAttachment => ({
    ...attachment,
    id: mapId(attachment.id),
    imageIds: attachment.imageIds.map(mapId),
  });
  const importedChatIds = new Set(chats.map((session) => session.id));
  const importedChats: ChatSession[] = chats.map((session) => ({
    ...session,
    id: mapId(session.id),
    seed: session.seed.map((message) => ({
      ...message,
      attachments: message.attachments?.map(remapAttachment),
    })),
    turns: session.turns.map((turn) => ({
      ...turn,
      id: mapId(turn.id),
      attachments: turn.attachments.map(remapAttachment),
      answers: Object.fromEntries(
        Object.entries(turn.answers).map(([model, answers]) => [
          model,
          answers.map((answer) => ({
            ...answer,
            id: mapId(answer.id),
            taskUUID: mapId(answer.taskUUID),
            status:
              answer.status === 'queued' || answer.status === 'streaming'
                ? ('interrupted' as const)
                : answer.status,
          })),
        ]),
      ),
      selectedAnswers: Object.fromEntries(
        Object.entries(turn.selectedAnswers).map(([model, answerId]) => [model, mapId(answerId)]),
      ),
    })),
    draftAttachments: session.draftAttachments.map(remapAttachment),
    fork: session.fork
      ? {
          ...session.fork,
          sessionId: importedChatIds.has(session.fork.sessionId)
            ? mapId(session.fork.sessionId)
            : session.fork.sessionId,
          turnId: importedChatIds.has(session.fork.sessionId)
            ? mapId(session.fork.turnId)
            : session.fork.turnId,
        }
      : undefined,
  }));
  const records = await Promise.all(media.map(mediaRecord));
  const tx = (await database).transaction(['works', 'jobs', 'media', 'chats'], 'readwrite');
  void tx.done.catch(() => {});
  for (const m of records) await tx.objectStore('media').add(m);
  for (const w of works) await tx.objectStore('works').add(w);
  for (const j of jobs) await tx.objectStore('jobs').add(j);
  for (const chat of importedChats) await tx.objectStore('chats').add(chat);
  await tx.done;
  if (data.chatSettings && typeof localStorage !== 'undefined') {
    try {
      const preferences = initialPreferences(localStorage.getItem('img-generator.preferences'), '');
      savePreferences({ ...preferences, chatSystemPrompt: data.chatSettings.systemPrompt });
    } catch {
      changed();
      throw new Error('作品已還原，但聊天偏好無法保存，請確認瀏覽器允許本機儲存。');
    }
  }
  changed();
  return works.length + importedChats.length;
}
