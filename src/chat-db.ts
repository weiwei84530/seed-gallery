import { changed, chatMediaIds, database } from './db';
import { isChatSessionActive, type ChatSession } from './chat-types';

export async function listChatSessions(): Promise<ChatSession[]> {
  return (await (await database).getAll('chats')).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChatSession(id: string): Promise<ChatSession | undefined> {
  return (await database).get('chats', id);
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  await (await database).add('chats', session);
  changed();
}

export async function updateChatSession(
  id: string,
  mutate: (session: ChatSession) => void,
): Promise<ChatSession> {
  const tx = (await database).transaction('chats', 'readwrite');
  void tx.done.catch(() => {});
  const session = await tx.store.get(id);
  if (!session) {
    tx.abort();
    throw new Error('找不到這段對話。');
  }
  try {
    const models = session.models.join(',');
    mutate(session);
    if (session.id !== id) throw new Error('不能更改對話 ID。');
    if (session.models.join(',') !== models)
      throw new Error('對話開始後不能更改模型，請建立新分支。');
    session.updatedAt = Date.now();
    await tx.store.put(session);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Transaction already closed. */
    }
    throw error;
  }
  changed();
  return session;
}

export async function removeChatSession(id: string): Promise<void> {
  const tx = (await database).transaction(['works', 'jobs', 'media', 'chats'], 'readwrite');
  void tx.done.catch(() => {});
  const session = await tx.objectStore('chats').get(id);
  if (!session) {
    await tx.done;
    return;
  }
  if (isChatSessionActive(session)) {
    tx.abort();
    throw new Error('對話仍在產生回覆，請先停止後再刪除。');
  }
  await tx.objectStore('chats').delete(id);
  const [works, jobs, chats] = await Promise.all([
    tx.objectStore('works').getAll(),
    tx.objectStore('jobs').getAll(),
    tx.objectStore('chats').getAll(),
  ]);
  const used = new Set([
    ...works.flatMap((work) => work.draft.refs),
    ...jobs.flatMap((job) => [...job.draft.refs, job.mediaId ?? '']),
    ...chats.flatMap(chatMediaIds),
  ]);
  for (const key of await tx.objectStore('media').getAllKeys()) {
    if (!used.has(key)) await tx.objectStore('media').delete(key);
  }
  await tx.done;
  changed();
}
