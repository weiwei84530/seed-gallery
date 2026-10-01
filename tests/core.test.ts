import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { initialPreferences, effectiveChatMode, setChatModeControls } from '../src/preferences';
import { calculateModelEstimate, estimateModelCost } from '../src/pricing';
import { buildRequest, currentDraft, dimensions, models, modelsFor } from '../src/models';
import { visibleWorks, workPreview } from '../src/work-list';
import { newDraft, type Job, type Work } from '../src/types';
import {
  addJobs,
  clearWorks,
  database,
  getMedia,
  removeWork,
  saveMedia,
  saveWork,
  storageUsage,
} from '../src/db';
import { exportBackup, importBackup } from '../src/backup';

afterEach(async () => {
  await clearWorks();
});
describe('preferences', () => {
  it('resets shared thinking mode on disable, re-enable and reload', () => {
    const deep = {
      ...initialPreferences(null, ''),
      chatModeControls: true,
      chatMode: 'deep' as const,
    };
    expect(effectiveChatMode(deep)).toBe('deep');
    const off = setChatModeControls(deep, false);
    expect(off.chatMode).toBe('balanced');
    expect(effectiveChatMode({ ...off, chatMode: 'deep' })).toBe('balanced');
    const reload = initialPreferences(JSON.stringify({ ...off, chatMode: 'deep' }), '');
    expect(reload.chatMode).toBe('balanced');
    expect(setChatModeControls(reload, true).chatMode).toBe('balanced');
    expect(initialPreferences(JSON.stringify(deep), '').chatMode).toBe('deep');
  });
  it('only uses the hidden URL default before a preference exists', () => {
    expect(initialPreferences(null, '').showMoney).toBe(true);
    expect(initialPreferences(null, '?costs=hidden').showMoney).toBe(false);
    expect(initialPreferences('{"showMoney":true}', '?costs=hidden').showMoney).toBe(true);
    expect(initialPreferences('{"showMoney":false}', '').showMoney).toBe(false);
    expect(initialPreferences('broken', '?costs=hidden').showMoney).toBe(false);
    expect(initialPreferences(null, '').balanceLimit).toBe(20);
    expect(initialPreferences('{"showMoney":true}', '').balanceLimit).toBe(20);
    expect(initialPreferences('{"showMoney":true,"balanceLimit":35}', '').balanceLimit).toBe(35);
  });
});
describe('pricing estimates', () => {
  it('matches the BFL calculator for first and additional output megapixels', () => {
    const rates = [
      { amount: 0.03, unit: 'outputMegapixel', label: 'First megapixel out' },
      { amount: 0.015, unit: 'outputMegapixel', label: 'Each further megapixel out', after: 1 },
    ];
    expect(calculateModelEstimate('flux', { ...newDraft(), ratio: 'square' }, rates)).toBeCloseTo(
      0.03,
    );
    expect(
      calculateModelEstimate('flux', { ...newDraft(), ratio: 'portrait', resolution: '2K' }, rates),
    ).toBeCloseTo(0.06);
    expect(
      calculateModelEstimate('flux', { ...newDraft(), ratio: 'square', resolution: '2K' }, rates),
    ).toBeCloseTo(0.075);
    expect(
      calculateModelEstimate('flux', { ...newDraft(), resolution: '2K' }, rates.slice(0, 1)),
    ).toBeNull();
  });
  it('uses exact catalog rates and refuses token-priced estimates', () => {
    const draft = newDraft();
    draft.models = ['banana'];
    draft.prompt = '花園中的貓咪';
    expect(
      calculateModelEstimate('banana', draft, [
        { amount: 0.06895, unit: 'output', label: '1K' },
        { amount: 0.00028, unit: 'inputImage' },
      ]),
    ).toBeCloseTo(0.06895);
    expect(calculateModelEstimate('gpt', draft, [])).toBeNull();
    expect(calculateModelEstimate('banana', { ...draft, googleSearch: true }, [])).toBeNull();
  });
  it('distinguishes video rates with and without audio', () => {
    const draft = {
      ...newDraft(),
      kind: 'video' as const,
      models: ['kling'] as ['kling'],
      duration: 4,
      videoResolution: '720p' as const,
      audio: false,
    };
    const rates = [
      { amount: 0.084, unit: 'durationSecond', label: '720p · no audio' },
      { amount: 0.126, unit: 'durationSecond', label: '720p · audio' },
    ];
    expect(calculateModelEstimate('kling', draft, rates)).toBeCloseTo(0.336);
    expect(calculateModelEstimate('kling', { ...draft, audio: true }, rates)).toBeCloseTo(0.504);
  });
});
describe('Runware request capabilities', () => {
  it('migrates editable GPT selections while keeping legacy model requests and names', () => {
    const oldDraft = { ...newDraft(), models: ['banana', 'gpt'] as const };
    const migrated = currentDraft({ ...oldDraft, models: [...oldDraft.models] });
    expect(migrated.models).toEqual(['banana', 'gptSunburst']);
    expect(oldDraft.models).toEqual(['banana', 'gpt']);
    expect(models.gpt.name).toBe('GPT Image 2');
    expect(modelsFor('image')).not.toContain('gpt');
    expect(modelsFor('image')).not.toContain('gptFlare');
    expect(
      currentDraft({ ...newDraft(), models: ['gpt', 'gptFlare', 'gptSunburst'] }).models,
    ).toEqual(['gptSunburst']);
    const flareRequest = buildRequest(
      'legacy-task',
      'gptFlare',
      { ...newDraft(), prompt: 'a flower', gptQuality: 'high' },
      [],
    );
    expect(flareRequest.model).toBe('openai:gpt-image@2.5-flare');
    expect(flareRequest.settings?.quality).toBe('high');
    const request = buildRequest(
      'task',
      'gptSunburst',
      { ...migrated, prompt: 'a flower', gptQuality: 'high', gptBackground: 'transparent' },
      [],
    );
    expect(request.model).toBe('openai:gpt-image@2.5-sunburst');
    expect(request.settings).toEqual({ quality: 'high', background: 'transparent' });
    expect(request.providerSettings).toBeUndefined();
  });
  it('explains unknown prices without substituting example prices', async () => {
    expect(await estimateModelCost('gptFlare', newDraft())).toEqual({
      amount: null,
      reason: '依實際用量計費，無法預估',
    });
    expect(
      (await estimateModelCost('banana', { ...newDraft(), googleSearch: true })).reason,
    ).toContain('網路搜尋');
    expect((await estimateModelCost('flux', { ...newDraft(), refs: ['photo'] })).reason).toContain(
      '參考照片',
    );
  });
  it('passes identical prompts and references to both models with their supported dimensions', () => {
    const draft = {
      ...newDraft(),
      prompt: '保留照片人物，換成水彩風格',
      refs: ['local-photo'],
      count: 2,
    };
    const banana = buildRequest('task', 'banana', draft, ['data:image/png;base64,test']);
    const gpt = buildRequest('task', 'gpt', draft, ['data:image/png;base64,test']);
    expect(banana.inputs).toEqual(gpt.inputs);
    expect(banana.positivePrompt).toBe(gpt.positivePrompt);
    expect(banana.model).toBe('google:4@3');
    expect(gpt.model).toBe('openai:gpt-image@2');
    expect(banana.height).toBe(1376);
    expect(gpt.height).toBe(1360);
    expect(gpt.numberResults).toBe(1);
    expect(gpt.deliveryMethod).toBe('async');
    expect(gpt.outputType).toBe('dataURI');
    expect(() => buildRequest('task', 'gpt', draft, [])).toThrow('參考照片');
  });
  it('keeps every GPT size inside the documented bounds and preserves advanced options', () => {
    for (const ratio of ['portrait', 'square', 'landscape'] as const)
      for (const resolution of ['1K', '2K'] as const) {
        const size = dimensions('gpt', { ...newDraft(), ratio, resolution });
        expect(size.width % 16).toBe(0);
        expect(size.height % 16).toBe(0);
        expect(size.width * size.height).toBeGreaterThanOrEqual(655360);
        expect(size.width * size.height).toBeLessThanOrEqual(8294400);
      }
    const request = buildRequest(
      'task',
      'gpt',
      { ...newDraft(), prompt: '一朵向日葵', gptBackground: 'transparent', gptQuality: 'high' },
      [],
    );
    expect('settings' in request && request.settings).toEqual({ background: 'transparent' });
    expect(request.providerSettings?.openai).toEqual({ quality: 'high' });
    expect(request.outputFormat).toBe('PNG');
  });
});
describe('work listing', () => {
  it('hides empty drafts but retains references, prompts, failed and pending work', () => {
    const base = { id: 'empty', title: 'draft', createdAt: 1, updatedAt: 1, draft: newDraft() };
    const works: Work[] = [
      base,
      { ...base, id: 'prompt', draft: { ...newDraft(), prompt: 'hello' } },
      { ...base, id: 'photo', draft: { ...newDraft(), refs: ['photo'] } },
      { ...base, id: 'failed' },
      { ...base, id: 'pending' },
    ];
    const job: Job = {
      id: 'job',
      workId: 'failed',
      batchId: 'batch',
      model: 'gpt',
      status: 'failed',
      createdAt: 1,
      draft: newDraft(),
      keyTag: '',
    };
    expect(
      visibleWorks(works, [job, { ...job, workId: 'pending', status: 'processing' }]).map(
        (work) => work.id,
      ),
    ).toEqual(['prompt', 'photo', 'failed', 'pending']);
    expect(works).toHaveLength(5);
  });
  it('uses the latest successful generation or the last reference as thumbnail', () => {
    const { work, job } = fixture();
    work.draft.refs = ['first', 'last'];
    expect(workPreview(work, [])).toBe('last');
    expect(
      workPreview(work, [
        { ...job, mediaId: 'older', createdAt: 1 },
        { ...job, mediaId: 'newer', createdAt: 2 },
        { ...job, status: 'failed', mediaId: undefined, createdAt: 3 },
      ]),
    ).toBe('newer');
  });
});
function fixture(): { work: Work; job: Job; mediaId: string } {
  const mediaId = crypto.randomUUID();
  const work = {
    id: crypto.randomUUID(),
    title: '測試作品',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    draft: { ...newDraft(), refs: [mediaId], prompt: '花園中的貓咪' },
  };
  const job: Job = {
    id: crypto.randomUUID(),
    workId: work.id,
    model: 'banana',
    batchId: crypto.randomUUID(),
    createdAt: Date.now(),
    status: 'succeeded',
    draft: work.draft,
    keyTag: 'private-fingerprint',
    mediaId,
    cost: 0.1,
  };
  return { work, job, mediaId };
}
describe('local data and backups', () => {
  it('atomically blocks concurrent paid batches for a work', async () => {
    const { work, job } = fixture();
    await saveWork(work);
    const result = await Promise.allSettled([
      addJobs([{ ...job, status: 'queued' }]),
      addJobs([{ ...job, id: crypto.randomUUID(), status: 'queued' }]),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await (await database).count('jobs')).toBe(1);
    const [stored] = await (await database).getAll('jobs');
    await (await database).put('jobs', { ...stored, status: 'failed' });
  });
  it('roundtrips image bytes without credentials and adds copies without overwriting existing work', async () => {
    const { work, job, mediaId } = fixture();
    await saveWork(work);
    await addJobs([job]);
    await saveMedia({
      id: mediaId,
      blob: new Blob(['actual-image-bytes'], { type: 'image/png' }),
      name: 'photo.png',
    });
    const blob = await exportBackup();
    expect(await storageUsage()).toBe(new Blob(['actual-image-bytes']).size);
    expect(await blob.text()).not.toContain('private-fingerprint');
    await importBackup(new File([blob], 'backup.zip'));
    const works = await (await database).getAll('works');
    expect(works).toHaveLength(2);
    expect(await storageUsage()).toBe(new Blob(['actual-image-bytes']).size * 2);
    const copied = works.find((w) => w.id !== work.id)!;
    expect(copied.draft.refs[0]).not.toBe(mediaId);
    expect(await (await getMedia(copied.draft.refs[0]))!.blob.text()).toBe('actual-image-bytes');
    await removeWork(work.id);
    expect(await (await database).count('works')).toBe(1);
    expect(await getMedia(copied.draft.refs[0])).toBeDefined();
    expect(await storageUsage()).toBe(new Blob(['actual-image-bytes']).size);
    await clearWorks();
    expect(await storageUsage()).toBe(0);
  });
  it('retains an image referenced from another work', async () => {
    const { work, job, mediaId } = fixture();
    await saveWork(work);
    await addJobs([job]);
    await saveMedia({
      id: mediaId,
      blob: new Blob(['image'], { type: 'image/png' }),
      name: 'photo.png',
    });
    await saveWork({ ...work, id: crypto.randomUUID() });
    await removeWork(work.id);
    expect(await getMedia(mediaId)).toBeDefined();
    expect(await storageUsage()).toBe(5);
  });
  it('rejects malformed backups without modifying the library', async () => {
    await expect(importBackup(new File(['not a zip'], 'bad.zip'))).rejects.toThrow();
    expect(await (await database).count('works')).toBe(0);
  });
});
