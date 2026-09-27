import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database } from '../src/db';
import { getChatSession, saveChatSession } from '../src/chat-db';
import { isChatSessionActive, type ChatSession } from '../src/chat-types';

vi.mock('../src/chat-api', async () => ({
  validateChatRequest: (await import('../src/chat-models')).validateChatRequest,
  streamChat: vi.fn(),
}));
import { streamChat } from '../src/chat-api';
import { recoverChatSessions, sendChat, stopChat } from '../src/chat-engine';

const locks = new Set<string>();
const session = (): ChatSession => ({
  id: crypto.randomUUID(),
  title: 'Test',
  models: ['gpt', 'gemini'],
  createdAt: 1,
  updatedAt: 1,
  seed: [],
  turns: [],
  draft: '',
  draftAttachments: [],
  search: false,
});
const send = (id: string, text = 'Question') =>
  sendChat({ sessionId: id, key: 'test-only', text, attachments: [], search: false });
const finished = async (id: string) => {
  await vi.waitFor(async () =>
    expect(isChatSessionActive((await getChatSession(id))!)).toBe(false),
  );
  await vi.waitFor(() => expect(locks.size).toBe(0));
};
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: {
      request: async (
        name: string,
        _: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        if (locks.has(name)) return callback(null);
        locks.add(name);
        try {
          await callback({ name });
        } finally {
          locks.delete(name);
        }
      },
    },
  });
  vi.mocked(streamChat).mockImplementation(async ({ model, onUpdate }) => {
    const value = { text: `Answer ${model}`, sources: [], cost: 0.001 };
    onUpdate(value);
    return value;
  });
});
afterEach(async () => {
  expect(locks.size).toBe(0);
  await (await database).clear('chats');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('broadcasts questions but isolates each model history and rejects concurrent submissions', async () => {
  const value = session();
  await saveChatSession(value);
  const attempts = await Promise.allSettled([send(value.id), send(value.id)]);
  expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  await finished(value.id);
  expect(vi.mocked(streamChat).mock.calls).toHaveLength(2);
  await send(value.id, 'Follow up');
  await finished(value.id);
  const calls = vi
    .mocked(streamChat)
    .mock.calls.slice(2)
    .map(([options]) => options);
  for (const call of calls) {
    expect(call.messages.map((item) => item.content)).toEqual([
      'Question',
      `Answer ${call.model}`,
      'Follow up',
    ]);
  }
});

it('stops one stream, keeps its partial answer, and retries only that model as a new version', async () => {
  const value = session();
  await saveChatSession(value);
  vi.mocked(streamChat).mockImplementation(async ({ model, onUpdate, signal }) => {
    const update = { text: `Partial ${model}`, sources: [], cost: undefined };
    onUpdate(update);
    if (model === 'gpt')
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }),
      );
    return update;
  });
  await send(value.id);
  await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
  stopChat(value.id, 'gpt');
  await finished(value.id);
  let stored = (await getChatSession(value.id))!;
  expect(stored.turns[0].answers.gpt![0]).toMatchObject({ status: 'stopped', text: 'Partial gpt' });
  expect(stored.turns[0].answers.gemini![0].status).toBe('complete');
  vi.mocked(streamChat).mockResolvedValue({ text: 'Retry answer', sources: [], cost: undefined });
  await sendChat({
    sessionId: value.id,
    key: 'test-only',
    text: '',
    attachments: [],
    search: false,
    retryModel: 'gpt',
  });
  await finished(value.id);
  stored = (await getChatSession(value.id))!;
  expect(stored.turns[0].answers.gpt).toHaveLength(2);
  expect(stored.turns[0].answers.gemini).toHaveLength(1);
  expect(vi.mocked(streamChat).mock.calls.at(-1)![0].messages).toHaveLength(1);
});

it('recovers stale sessions without touching a lock held by another tab or replaying requests', async () => {
  const stale = session();
  const live = session();
  for (const value of [stale, live]) {
    value.turns = [
      {
        id: crypto.randomUUID(),
        text: 'Question',
        attachments: [],
        search: false,
        createdAt: 1,
        selectedAnswers: {},
        answers: {
          gpt: [
            {
              id: crypto.randomUUID(),
              taskUUID: crypto.randomUUID(),
              text: 'Saved text',
              status: 'streaming',
              sources: [],
              createdAt: 1,
            },
          ],
        },
      },
    ];
    await saveChatSession(value);
  }
  locks.add(`seed-gallery.chat.${live.id}`);
  await recoverChatSessions();
  expect((await getChatSession(stale.id))!.turns[0].answers.gpt![0]).toMatchObject({
    status: 'interrupted',
    text: 'Saved text',
  });
  expect(isChatSessionActive((await getChatSession(live.id))!)).toBe(true);
  expect(streamChat).not.toHaveBeenCalled();
  locks.clear();
});
