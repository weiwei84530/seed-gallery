import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { newDraft, newVideoDraft, type Job } from '../src/types';
import { buildRequest, dimensions, validateDraft } from '../src/models';
import { rememberedDraft, rememberDraft, clearDraftDefaults } from '../src/draft-defaults';
import { videoBlob } from '../src/runware';
import { clearWorks, database, saveMedia, saveWork } from '../src/db';
import { exportBackup, importBackup } from '../src/backup';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearWorks();
});

it('keeps category settings separate without carrying prompts or photos into a new work', () => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  rememberDraft({
    ...newDraft(),
    models: ['banana'],
    count: 2,
    ratio: 'square',
    prompt: 'private prompt',
    refs: [crypto.randomUUID()],
  });
  rememberDraft({
    ...newVideoDraft(),
    models: ['veo'],
    duration: 8,
    audio: true,
    videoResolution: '1080p',
  });
  expect(rememberedDraft('image')).toMatchObject({
    models: ['banana'],
    count: 2,
    ratio: 'square',
    prompt: '',
    refs: [],
  });
  expect(rememberedDraft('video')).toMatchObject({
    models: ['veo'],
    duration: 8,
    audio: true,
    videoResolution: '1080p',
    prompt: '',
    refs: [],
  });
  expect([...memory.values()].join('')).not.toContain('private prompt');
  clearDraftDefaults();
  expect(rememberedDraft('video').models).toEqual(['kling']);
  memory.set('img-generator.defaults.image', '{broken');
  expect(rememberedDraft('image').models).toEqual(['banana', 'gptSunburst']);
});

it('adapts video input and audio parameters without sending forbidden dimensions with first frames', () => {
  for (const model of ['kling', 'seedance', 'veo'] as const) {
    const draft = {
      ...newVideoDraft(),
      models: [model],
      prompt: 'A flower sways gently',
      audio: true,
    };
    const text = buildRequest(crypto.randomUUID(), model, draft, []);
    expect(text).toMatchObject({
      taskType: 'videoInference',
      width: 720,
      height: 1280,
      duration: 4,
      numberResults: 1,
      outputType: 'URL',
      outputFormat: 'MP4',
    });
    const edit = buildRequest(crypto.randomUUID(), model, { ...draft, refs: ['photo'] }, [
      'data:image/png;base64,reference',
    ]);
    expect(edit.width).toBeUndefined();
    expect(edit.height).toBeUndefined();
    expect(edit.inputs?.frameImages?.[0]).toEqual({
      image: 'data:image/png;base64,reference',
      frame: 'first',
    });
    expect(edit.resolution).toBe(model === 'kling' ? undefined : '720p');
    expect(
      model === 'kling'
        ? edit.providerSettings?.klingai.sound
        : model === 'seedance'
          ? edit.settings?.audio
          : edit.providerSettings?.google.generateAudio,
    ).toBe(true);
  }
  expect(() =>
    validateDraft({
      ...newVideoDraft(),
      models: ['kling'],
      videoResolution: '1080p',
      prompt: 'A flower sways',
    }),
  ).toThrow('720p');
  expect(() =>
    validateDraft({ ...newVideoDraft(), models: ['banana'], prompt: 'A flower sways' }),
  ).toThrow('類別');
  expect(() =>
    validateDraft({ ...newDraft(), models: ['seedream'], prompt: 'x'.repeat(3001) }),
  ).toThrow('3,000');
  expect(() =>
    validateDraft({ ...newVideoDraft(), prompt: 'A flower sways', klingNegativePrompt: 'x' }),
  ).toThrow('2 個字');
});

it('keeps expanded image dimensions inside each model bounds and sends references to both', () => {
  for (const model of ['flux', 'seedream'] as const)
    for (const resolution of ['1K', '2K'] as const)
      for (const ratio of ['portrait', 'square', 'landscape'] as const) {
        const draft = {
          ...newDraft(),
          prompt: 'a sunflower',
          models: [model],
          ratio,
          resolution,
          refs: ['photo'],
        };
        const { width, height } = dimensions(model, draft);
        if (model === 'flux') {
          expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
          expect(width % 16).toBe(0);
          expect(height % 16).toBe(0);
        } else {
          expect(width * height).toBeGreaterThanOrEqual(921600);
          expect(width * height).toBeLessThanOrEqual(4624220);
        }
        expect(buildRequest('task', model, draft, ['photo-data']).inputs?.referenceImages).toEqual([
          'photo-data',
        ]);
      }
});

it('downloads MP4 bytes and rejects untrusted sources, non-video responses, and oversized media', async () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
  expect((await videoBlob({ videoURL: 'https://im.runware.ai/test.mp4' })).type).toBe('video/mp4');
  await expect(videoBlob({ videoURL: 'https://other.example/test.mp4' })).rejects.toThrow('來源');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not an mp4')));
  await expect(videoBlob({ videoURL: 'https://im.runware.ai/test.mp4' })).rejects.toThrow('格式');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(bytes, { headers: { 'content-length': String(101 * 1024 * 1024) } }),
      ),
  );
  await expect(videoBlob({ videoURL: 'https://im.runware.ai/test.mp4' })).rejects.toThrow('100 MB');
});

it('roundtrips video bytes and continues importing version-one image backups', async () => {
  const id = crypto.randomUUID();
  const mediaId = crypto.randomUUID();
  const draft = { ...newVideoDraft(), prompt: 'A gentle breeze' };
  await saveWork({ id, title: 'Video', createdAt: 1, updatedAt: 1, draft });
  await saveMedia({
    id: mediaId,
    blob: new Blob(['video bytes'], { type: 'video/mp4' }),
    name: 'test.mp4',
  });
  const job: Job = {
    id: crypto.randomUUID(),
    workId: id,
    batchId: crypto.randomUUID(),
    model: 'kling',
    status: 'succeeded',
    createdAt: 1,
    draft,
    mediaId,
    keyTag: 'private-key-tag',
  };
  await (await database).put('jobs', job);
  await (await database).put('jobs', {
    ...job,
    id: crypto.randomUUID(),
    status: 'retrieval_failed',
    mediaId: undefined,
  });
  const backup = await exportBackup();
  await importBackup(new File([backup], 'backup.zip'));
  expect(await (await database).count('works')).toBe(2);
  expect((await (await database).getAll('jobs')).some((saved) => saved.status === 'unknown')).toBe(true);
  expect((await (await database).getAll('media')).every((m) => m.type === 'video/mp4')).toBe(true);
  const entries = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(JSON.stringify(manifest)).not.toContain('private-key-tag');
  const invalid = structuredClone(manifest);
  invalid.works[0].draft.refs = [manifest.media[0].id];
  await expect(
    importBackup(
      new File(
        [
          new Uint8Array(
            zipSync({
              ...entries,
              'manifest.json': strToU8(JSON.stringify(invalid)),
            }),
          ),
        ],
        'invalid.zip',
      ),
    ),
  ).rejects.toThrow('照片格式');
  expect(await (await database).count('works')).toBe(2);
  manifest.version = 1;
  manifest.works = [{ ...manifest.works[0], draft: newDraft() }];
  manifest.jobs = [];
  manifest.media = [];
  const legacy = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) });
  await importBackup(new File([new Uint8Array(legacy)], 'legacy.zip'));
  expect(await (await database).count('works')).toBe(3);
});
