import 'fake-indexeddb/auto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { openDB } from 'idb';
import { afterEach, expect, it } from 'vitest';
import type { ChatAttachment, ChatSession } from '../src/chat-types';
import { newDraft } from '../src/types';

const makeAttachment = (imageId: string): ChatAttachment => ({
  id: imageId,
  name: 'photo.png',
  type: 'image/png',
  size: 3,
  imageIds: [imageId],
});
const makeSession = (patch: Partial<ChatSession> = {}): ChatSession => ({
  id: crypto.randomUUID(),
  title: 'Conversation',
  models: ['gpt'],
  createdAt: 1,
  updatedAt: 1,
  seed: [],
  turns: [],
  draft: '',
  draftAttachments: [],
  search: false,
  ...patch,
});

afterEach(async () => {
  const { clearWorks } = await import('../src/db');
  await clearWorks();
});

it('upgrades a version-one database without losing existing works or media', async () => {
  const old = await openDB('img-generator', 1, {
    upgrade(db) {
      db.createObjectStore('works', { keyPath: 'id' });
      db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('workId', 'workId');
      db.createObjectStore('media', { keyPath: 'id' });
    },
  });
  const workId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  await old.put('works', {
    id: workId,
    title: 'Old work',
    createdAt: 1,
    updatedAt: 1,
    draft: { ...newDraft(), refs: [imageId] },
  });
  await old.put('media', {
    id: imageId,
    type: 'image/png',
    name: 'old.png',
    bytes: new Uint8Array([1]).buffer,
  });
  old.close();
  const { database } = await import('../src/db');
  const db = await database;
  expect(db.version).toBe(2);
  expect((await db.get('works', workId))?.title).toBe('Old work');
  expect((await db.get('media', imageId))?.bytes.byteLength).toBe(1);
  expect(await db.count('chats')).toBe(0);
});

it('keeps fork images after deleting their source work and conversation', async () => {
  const { saveMedia, saveWork, removeWork, getMedia, database } = await import('../src/db');
  const { saveChatSession, removeChatSession } = await import('../src/chat-db');
  const workId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  await saveMedia({
    id: imageId,
    name: 'photo.png',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  });
  await saveWork({
    id: workId,
    title: 'Source',
    createdAt: 1,
    updatedAt: 1,
    draft: { ...newDraft(), refs: [imageId] },
  });
  const source = makeSession({ draftAttachments: [makeAttachment(imageId)] });
  const fork = makeSession({
    seed: [{ role: 'user', content: 'Look at this', attachments: [makeAttachment(imageId)] }],
    fork: { sessionId: source.id, model: 'gpt', turnId: crypto.randomUUID() },
  });
  await saveChatSession(source);
  await saveChatSession(fork);
  await removeWork(workId);
  await removeChatSession(source.id);
  expect((await getMedia(imageId))?.blob.size).toBe(3);
  await removeChatSession(fork.id);
  expect(await (await database).get('media', imageId)).toBeUndefined();
});

it('roundtrips original text files and PDF page images and protects both from collection', async () => {
  const { saveMedia, getMedia, removeWork } = await import('../src/db');
  const { saveChatSession, listChatSessions, removeChatSession } = await import('../src/chat-db');
  const { exportBackup, importBackup } = await import('../src/backup');
  const original = crypto.randomUUID();
  const page = crypto.randomUUID();
  const note = crypto.randomUUID();
  for (const [id, type, content] of [
    [original, 'application/pdf', 'original pdf'],
    [page, 'image/png', 'rendered page'],
    [note, 'text/plain', 'original text'],
  ])
    await saveMedia({ id, name: 'file', blob: new Blob([content], { type }) });
  const value = makeSession({
    draftAttachments: [
      { id: original, name: 'scan.pdf', type: 'application/pdf', size: 12, imageIds: [page] },
      {
        id: note,
        name: 'note.txt',
        type: 'text/plain',
        size: 13,
        text: 'original text',
        imageIds: [],
      },
    ],
  });
  await saveChatSession(value);
  await removeWork('absent-work');
  expect(await getMedia(original)).toBeDefined();
  expect(await getMedia(note)).toBeDefined();
  await importBackup(new File([await exportBackup()], 'backup.zip'));
  await removeChatSession(value.id);
  const [copy] = await listChatSessions();
  expect(await (await getMedia(copy.draftAttachments[0].id))!.blob.text()).toBe('original pdf');
  expect(await (await getMedia(copy.draftAttachments[1].id))!.blob.text()).toBe('original text');
  expect(await getMedia(copy.draftAttachments[0].imageIds[0])).toBeDefined();
});

it('roundtrips chat versions, attachments and sources; interrupts active imported answers', async () => {
  const { saveMedia, database, clearWorks } = await import('../src/db');
  const { saveChatSession, listChatSessions } = await import('../src/chat-db');
  const { exportBackup, importBackup } = await import('../src/backup');
  const imageId = crypto.randomUUID();
  await saveMedia({
    id: imageId,
    name: 'photo.png',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  });
  const answerId = crypto.randomUUID();
  const source = makeSession({
    models: ['gpt', 'gemini'],
    seed: [{ role: 'user', content: 'Seed', attachments: [makeAttachment(imageId)] }],
    draftAttachments: [makeAttachment(imageId)],
    turns: [
      {
        id: crypto.randomUUID(),
        text: 'Question',
        attachments: [makeAttachment(imageId)],
        search: true,
        createdAt: 3,
        answers: {
          gpt: [
            {
              id: answerId,
              taskUUID: crypto.randomUUID(),
              text: 'Partial',
              status: 'streaming',
              sources: [{ title: 'Reference', url: 'https://example.com' }],
              cost: 0.01,
              createdAt: 3,
            },
          ],
        },
        selectedAnswers: { gpt: answerId },
      },
    ],
  });
  const fork = makeSession({
    models: ['gpt54', 'geminiFlash'],
    fork: { sessionId: source.id, model: 'gpt', turnId: source.turns[0].id },
  });
  await saveChatSession(source);
  await saveChatSession(fork);
  const archive = await exportBackup();
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.version).toBe(3);
  expect(manifest.chats).toHaveLength(2);
  // The original active answer must be settled before clearing all local data.
  const { updateChatSession } = await import('../src/chat-db');
  await updateChatSession(source.id, (session) => {
    session.turns[0].answers.gpt![0].status = 'stopped';
  });
  await clearWorks();
  expect(await importBackup(new File([archive], 'backup.zip'))).toBe(2);
  const restored = await listChatSessions();
  const restoredSource = restored.find((session) => session.seed.length)!;
  const restoredFork = restored.find((session) => session.fork)!;
  expect(restoredSource.models).toEqual(['gpt', 'gemini']);
  expect(restoredFork.models).toEqual(['gpt54', 'geminiFlash']);
  expect(restoredSource.id).not.toBe(source.id);
  expect(restoredSource.turns[0].id).not.toBe(source.turns[0].id);
  expect(restoredSource.turns[0].answers.gpt![0].id).not.toBe(answerId);
  expect(restoredSource.turns[0].answers.gpt![0].status).toBe('interrupted');
  expect(restoredSource.turns[0].selectedAnswers.gpt).toBe(
    restoredSource.turns[0].answers.gpt![0].id,
  );
  expect(restoredFork.fork?.sessionId).toBe(restoredSource.id);
  expect(restoredFork.fork?.turnId).toBe(restoredSource.turns[0].id);
  const importedImageId = restoredSource.seed[0].attachments![0].imageIds[0];
  expect(importedImageId).not.toBe(imageId);
  expect(restoredSource.turns[0].attachments[0].imageIds[0]).toBe(importedImageId);
  expect(restoredSource.draftAttachments[0].imageIds[0]).toBe(importedImageId);
  expect((await (await database).get('media', importedImageId))?.bytes.byteLength).toBe(3);
  expect(restoredSource.turns[0].answers.gpt![0].sources[0].url).toBe('https://example.com');
});

it('imports old backup versions and rejects malformed chat references atomically', async () => {
  const { exportBackup, importBackup } = await import('../src/backup');
  const { database } = await import('../src/db');
  const { saveChatSession } = await import('../src/chat-db');
  const archive = await exportBackup();
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  for (const version of [1, 2]) {
    const legacy = { ...manifest, version, chats: undefined };
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(legacy)) });
    expect(await importBackup(new File([new Uint8Array(bytes)], 'legacy.zip'))).toBe(0);
  }
  const invalid = makeSession({ draftAttachments: [makeAttachment(crypto.randomUUID())] });
  manifest.chats = [invalid];
  const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) });
  await expect(importBackup(new File([new Uint8Array(bytes)], 'invalid.zip'))).rejects.toThrow();
  expect(await (await database).count('chats')).toBe(0);
  await saveChatSession(makeSession());
  expect(await (await database).count('chats')).toBe(1);
});

it('rejects invalid chat model, answer status, cost and selected answer IDs', async () => {
  const { exportBackup, importBackup } = await import('../src/backup');
  const { database } = await import('../src/db');
  const entries = unzipSync(new Uint8Array(await (await exportBackup()).arrayBuffer()));
  const base = JSON.parse(strFromU8(entries['manifest.json']));
  const answerId = crypto.randomUUID();
  const session = makeSession({
    turns: [
      {
        id: crypto.randomUUID(),
        text: 'Question',
        attachments: [],
        search: false,
        createdAt: 1,
        answers: {
          gpt: [
            {
              id: answerId,
              taskUUID: crypto.randomUUID(),
              text: 'Answer',
              status: 'complete',
              sources: [],
              cost: 0.01,
              createdAt: 1,
            },
          ],
        },
        selectedAnswers: { gpt: answerId },
      },
    ],
  });
  const invalid = [
    (chat: ChatSession) => {
      chat.models = ['gpt', 'gpt'];
    },
    (chat: ChatSession) => {
      chat.models = [];
    },
    (chat: ChatSession) => {
      (chat.models as string[])[0] = 'unknown';
    },
    (chat: ChatSession) => {
      (chat.turns[0].answers.gpt![0].status as string) = 'pending';
    },
    (chat: ChatSession) => {
      chat.turns[0].answers.gpt![0].cost = -1;
    },
    (chat: ChatSession) => {
      chat.turns[0].selectedAnswers.gpt = crypto.randomUUID();
    },
  ];
  for (const mutate of invalid) {
    const candidate = structuredClone(session);
    mutate(candidate);
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...base, chats: [candidate] })),
    });
    await expect(importBackup(new File([new Uint8Array(bytes)], 'invalid.zip'))).rejects.toThrow();
    expect(await (await database).count('chats')).toBe(0);
  }
});

it('serializes updates and prevents stale creates or deletion while active', async () => {
  const { saveChatSession, updateChatSession, getChatSession, removeChatSession } =
    await import('../src/chat-db');
  const { clearWorks } = await import('../src/db');
  const session = makeSession({ draft: '0' });
  await saveChatSession(session);
  await expect(saveChatSession({ ...session, draft: 'stale' })).rejects.toThrow();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      updateChatSession(session.id, (current) => {
        current.draft = String(Number(current.draft) + 1);
      }),
    ),
  );
  expect((await getChatSession(session.id))?.draft).toBe('10');
  const answerId = crypto.randomUUID();
  await updateChatSession(session.id, (current) => {
    current.turns.push({
      id: crypto.randomUUID(),
      text: 'Question',
      attachments: [],
      search: false,
      createdAt: 1,
      answers: {
        gpt: [
          {
            id: answerId,
            taskUUID: crypto.randomUUID(),
            text: '',
            status: 'queued',
            sources: [],
            createdAt: 1,
          },
        ],
      },
      selectedAnswers: { gpt: answerId },
    });
  });
  await expect(removeChatSession(session.id)).rejects.toThrow();
  await expect(clearWorks()).rejects.toThrow();
  await updateChatSession(session.id, (current) => {
    current.turns[0].answers.gpt![0].status = 'stopped';
  });
  await removeChatSession(session.id);
  expect(await getChatSession(session.id)).toBeUndefined();
});
