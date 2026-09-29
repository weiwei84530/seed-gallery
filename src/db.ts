import { openDB, type DBSchema } from 'idb';
import type { Job, Media, Work } from './types';
import { isChatSessionActive, type ChatSession } from './chat-types';

interface StudioDB extends DBSchema {
  works: { key: string; value: Work };
  jobs: { key: string; value: Job; indexes: { workId: string } };
  media: { key: string; value: StoredMedia };
  chats: { key: string; value: ChatSession };
}
export interface StoredMedia {
  id: string;
  bytes: ArrayBuffer;
  type: string;
  name: string;
}
export async function mediaRecord(media: Media): Promise<StoredMedia> {
  return {
    id: media.id,
    bytes: await media.blob.arrayBuffer(),
    type: media.blob.type,
    name: media.name,
  };
}
export function asMedia(record: StoredMedia): Media {
  return {
    id: record.id,
    blob: new Blob([record.bytes], { type: record.type }),
    name: record.name,
  };
}
let upgradeBlocked = false;
export function isDatabaseUpgradeBlocked() {
  return upgradeBlocked;
}
export const database = openDB<StudioDB>('img-generator', 2, {
  blocked() {
    upgradeBlocked = true;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio-db-blocked'));
  },
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore('works', { keyPath: 'id' });
      db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('workId', 'workId');
      db.createObjectStore('media', { keyPath: 'id' });
    }
    if (oldVersion < 2) db.createObjectStore('chats', { keyPath: 'id' });
  },
});
export function chatMediaIds(session: ChatSession): string[] {
  const attachments = [
    ...session.seed.flatMap((message) => message.attachments ?? []),
    ...session.turns.flatMap((turn) => turn.attachments),
    ...session.draftAttachments,
  ];
  return attachments.flatMap((attachment) => [attachment.id, ...attachment.imageIds]);
}
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('img-generator.updates') : null;
export function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio-change'));
  channel?.postMessage('updated');
}
if (channel && typeof window !== 'undefined')
  channel.onmessage = () => window.dispatchEvent(new Event('studio-change'));
export async function saveWork(work: Work) {
  await (await database).put('works', work);
  changed();
}
export async function saveJob(job: Job) {
  await (await database).put('jobs', job);
  changed();
}
export async function getMedia(id: string) {
  const record = await (await database).get('media', id);
  return record ? asMedia(record) : undefined;
}
export async function saveMedia(media: Media) {
  const record = await mediaRecord(media);
  await (await database).put('media', record);
  return media.id;
}
export async function snapshot() {
  const db = await database;
  const [works, jobs] = await Promise.all([db.getAll('works'), db.getAll('jobs')]);
  return {
    works: works.sort((a, b) => b.updatedAt - a.updatedAt),
    jobs: jobs.sort((a, b) => a.createdAt - b.createdAt),
  };
}
export async function storageUsage() {
  // Walk one file at a time instead of cloning the entire media library into memory.
  const tx = (await database).transaction('media');
  let cursor = await tx.store.openCursor();
  let total = 0;
  while (cursor) {
    total += cursor.value.bytes.byteLength;
    cursor = await cursor.continue();
  }
  await tx.done;
  return total;
}
export async function addJobs(jobs: Job[]) {
  const tx = (await database).transaction('jobs', 'readwrite');
  const existing = await tx.store.index('workId').getAll(jobs[0].workId);
  if (existing.some((j) => ['queued', 'sending', 'processing'].includes(j.status))) {
    await tx.done;
    throw new Error('這份作品已有生成中的任務，請等完成後再送出。');
  }
  for (const job of jobs) await tx.store.add(job);
  await tx.done;
  changed();
}
export async function removeWork(id: string) {
  const tx = (await database).transaction(['works', 'jobs', 'media', 'chats'], 'readwrite');
  await tx.objectStore('works').delete(id);
  const jobs = await tx.objectStore('jobs').index('workId').getAll(id);
  for (const job of jobs) await tx.objectStore('jobs').delete(job.id);
  const remainingWorks = await tx.objectStore('works').getAll();
  const remainingJobs = await tx.objectStore('jobs').getAll();
  const chats = await tx.objectStore('chats').getAll();
  const used = new Set([
    ...remainingWorks.flatMap((w) => w.draft.refs),
    ...remainingJobs.flatMap((j) => [...j.draft.refs, j.mediaId ?? '']),
    ...chats.flatMap(chatMediaIds),
  ]);
  for (const key of await tx.objectStore('media').getAllKeys())
    if (!used.has(key)) await tx.objectStore('media').delete(key);
  await tx.done;
  changed();
}
export async function clearWorks() {
  const tx = (await database).transaction(['works', 'jobs', 'media', 'chats'], 'readwrite');
  void tx.done.catch(() => {});
  const jobs = await tx.objectStore('jobs').getAll();
  const chats = await tx.objectStore('chats').getAll();
  if (
    jobs.some((job) => ['queued', 'sending', 'processing'].includes(job.status)) ||
    chats.some(isChatSessionActive)
  ) {
    tx.abort();
    throw new Error('仍有正在處理的作品或對話，請完成或停止後再清除。');
  }
  await Promise.all([
    tx.objectStore('works').clear(),
    tx.objectStore('jobs').clear(),
    tx.objectStore('media').clear(),
    tx.objectStore('chats').clear(),
  ]);
  await tx.done;
  changed();
}
