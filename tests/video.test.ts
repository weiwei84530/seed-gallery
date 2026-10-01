import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { newDraft, newVideoDraft, type Job } from '../src/types';
import {
  buildRequest,
  currentDraft,
  dimensions,
  modelsFor,
  validateDraft,
  videoAudioFor,
  videoResolutionFor,
  videoResolutionOptions,
} from '../src/models';
import { calculateModelEstimate } from '../src/pricing';
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
    models: ['seedance', 'minimax'],
    duration: 8,
    videoAudio: { seedance: false },
    videoResolutions: { seedance: '480p', minimax: '1440p' },
  });
  expect(rememberedDraft('image')).toMatchObject({
    models: ['banana'],
    count: 2,
    ratio: 'square',
    prompt: '',
    refs: [],
  });
  expect(rememberedDraft('video')).toMatchObject({
    models: ['seedance', 'minimax'],
    duration: 8,
    videoAudio: { seedance: false },
    videoResolutions: { seedance: '480p', minimax: '1440p' },
    prompt: '',
    refs: [],
  });
  expect([...memory.values()].join('')).not.toContain('private prompt');
  clearDraftDefaults();
  expect(rememberedDraft('video').models).toEqual(['kling']);
  memory.set('img-generator.defaults.image', '{broken');
  expect(rememberedDraft('image').models).toEqual(['banana', 'gptSunburst']);
});

it('migrates editable Veo drafts while leaving historical jobs and their requested settings intact', () => {
  const legacy = {
    ...newVideoDraft(),
    models: ['veo', 'seedance'] as const,
    videoResolution: '720p' as const,
    audio: false,
  };
  const draft = currentDraft({ ...legacy, models: [...legacy.models] });
  expect(draft.models).toEqual(['seedance']);
  expect(draft.videoResolutions).toEqual({ seedance: '720p' });
  expect(videoAudioFor('seedance', draft)).toBe(true);
  expect(legacy.models).toEqual(['veo', 'seedance']);
  expect(videoAudioFor('veo', legacy as unknown as ReturnType<typeof newVideoDraft>)).toBe(false);
  expect(
    currentDraft({ ...newVideoDraft(), models: ['veo'], videoResolution: '1080p' }).models,
  ).toEqual(['kling']);
  expect(modelsFor('video')).toHaveLength(6);
  expect(modelsFor('video')).not.toContain('veo');
});

it('uses each selected video model resolution and documented dimensions independently', () => {
  const configurations = [
    ['omni', '360p', 640, 360, undefined],
    ['omni', '720p', 1280, 720, undefined],
    ['wan', '480p', 832, 480, 624],
    ['wan', '720p', 1280, 720, 960],
    ['seedance', '480p', 864, 496, 640],
    ['seedance', '720p', 1280, 720, 960],
    ['minimax', '768p', 1344, 768, 768],
    ['minimax', '1440p', 2560, 1440, 1440],
    ['seedance25', '480p', 854, 480, 640],
    ['kling', '720p', 1280, 720, 960],
  ] as const;
  for (const [model, resolution, width, height, square] of configurations) {
    const draft = {
      ...newVideoDraft(),
      models: [model],
      prompt: 'A flower gently sways',
      videoResolutions: { [model]: resolution },
    };
    expect(videoResolutionOptions(model)).toContain(resolution);
    const text = buildRequest('task', model, { ...draft, ratio: 'landscape' }, []);
    expect(text).toMatchObject({ width, height });
    expect(text.resolution).toBeUndefined();
    expect(dimensions(model, draft)).toEqual({ width: height, height: width });
    if (square)
      expect(dimensions(model, { ...draft, ratio: 'square' })).toEqual({
        width: square,
        height: square,
      });
    else expect(() => validateDraft({ ...draft, ratio: 'square' })).toThrow('比例');
    const photo = buildRequest('task', model, { ...draft, refs: ['photo'] }, [
      'data:image/png;base64,reference',
    ]);
    expect(photo.width).toBeUndefined();
    expect(photo.height).toBeUndefined();
    expect(photo.resolution).toBe(model === 'kling' ? undefined : resolution);
    if (['omni', 'minimax'].includes(model)) {
      expect(photo.settings).toBeUndefined();
      expect(photo.providerSettings).toBeUndefined();
    } else if (model === 'kling') expect(photo.providerSettings?.klingai.sound).toBe(true);
    else expect(photo.settings?.audio).toBe(true);
  }
  const draft = {
    ...newVideoDraft(),
    models: modelsFor('video'),
    prompt: 'A flower gently sways',
    videoResolutions: { seedance: '480p' as const, minimax: '1440p' as const },
    videoAudio: { seedance: false },
  };
  validateDraft(draft);
  expect(videoResolutionFor('seedance25', draft)).toBe('480p');
  expect(videoResolutionFor('wan', draft)).toBe('720p');
  expect(buildRequest('task', 'seedance', draft, []).settings?.audio).toBe(false);
  expect(buildRequest('task', 'wan', draft, []).settings?.audio).toBe(true);
  expect(() => validateDraft({ ...draft, videoResolutions: { seedance25: '720p' } })).toThrow(
    '480p',
  );
});

it('prices the per-model video tier and audio choice without substituting other generation modes', () => {
  const draft = {
    ...newVideoDraft(),
    duration: 6,
    videoResolutions: { seedance: '480p' as const, minimax: '1440p' as const },
  };
  expect(
    calculateModelEstimate('seedance', draft, [
      { amount: 0.06, unit: 'durationSecond', label: '480p' },
      { amount: 0.13, unit: 'durationSecond', label: '720p' },
    ]),
  ).toBeCloseTo(0.36);
  expect(
    calculateModelEstimate('minimax', draft, [
      { amount: 0.08, unit: 'durationSecond', label: '768p' },
      { amount: 0.13, unit: 'durationSecond', label: '2K' },
    ]),
  ).toBeCloseTo(0.78);
  expect(
    calculateModelEstimate('seedance25', draft, [
      { amount: 0.1313, unit: 'durationSecond', label: 'Video-to-Video · 480p' },
      { amount: 0.1025, unit: 'durationSecond', label: 'Text/Image to Video · 480p' },
    ]),
  ).toBeCloseTo(0.615);
  expect(
    calculateModelEstimate('omni', draft, [
      { amount: 0.0000175, unit: 'outputToken', label: 'Video output' },
    ]),
  ).toBeNull();
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
  await (
    await database
  ).put('jobs', {
    ...job,
    id: crypto.randomUUID(),
    status: 'retrieval_failed',
    mediaId: undefined,
  });
  const backup = await exportBackup();
  await importBackup(new File([backup], 'backup.zip'));
  expect(await (await database).count('works')).toBe(2);
  expect((await (await database).getAll('jobs')).some((saved) => saved.status === 'unknown')).toBe(
    true,
  );
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
