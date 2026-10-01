import { describe, expect, it } from 'vitest';
import { buildRequest, currentDraft, dimensions, models, modelsFor } from '../src/models';
import { calculateModelEstimate } from '../src/pricing';
import { draftSchema } from '../src/draft-schema';
import { newDraft } from '../src/types';

describe('Grok and Muse image requests', () => {
  it('uses legal text dimensions and keeps independent Grok settings', () => {
    const draft = currentDraft({
      ...newDraft(),
      prompt: 'A floral poster',
      models: ['grok', 'muse'],
    });
    const grok = buildRequest('task', 'grok', { ...draft, resolution: '2K' }, []);
    expect(grok).toMatchObject({
      model: 'xai:grok-imagine@image-2.0',
      width: 720,
      height: 1280,
      settings: { quality: 'medium' },
    });
    expect(
      buildRequest('task', 'grok', { ...draft, grokResolution: '2K', grokQuality: 'low' }, []),
    ).toMatchObject({ width: 1584, height: 2816, settings: { quality: 'low' } });
    expect(buildRequest('task', 'muse', draft, [])).toMatchObject({
      model: 'meta:muse@image',
      width: 1152,
      height: 2048,
      settings: { thinkingLevel: 'high', webSearch: false, imageSearch: false },
    });
    expect(dimensions('muse', { ...draft, ratio: 'square' })).toEqual({
      width: 1600,
      height: 1600,
    });
    expect(dimensions('grok', { ...draft, ratio: 'landscape' })).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('sends every reference without conflicting dimensions and rejects a fourth Grok photo', () => {
    const refs = [
      'data:image/png;base64,one',
      'data:image/png;base64,two',
      'data:image/png;base64,three',
    ];
    const draft = {
      ...newDraft(),
      models: ['grok', 'muse'] as const,
      prompt: 'Edit this photo',
      refs: ['one', 'two', 'three'],
      grokResolution: '2K' as const,
    };
    for (const model of ['grok', 'muse'] as const) {
      const request = buildRequest('task', model, { ...draft, models: [...draft.models] }, refs);
      expect(request.inputs?.referenceImages).toEqual(refs);
      expect(request.resolution).toBe('2K');
      expect(request).not.toHaveProperty('width');
      expect(request).not.toHaveProperty('height');
    }
    expect(() =>
      buildRequest(
        'task',
        'grok',
        { ...newDraft(), prompt: 'Edit this photo', models: ['grok'], refs: ['1', '2', '3', '4'] },
        ['1', '2', '3', '4'],
      ),
    ).toThrow(/Grok/);
  });

  it('retires FLUX editable selections while retaining historical metadata and settings', () => {
    const legacy = { ...newDraft(), models: ['flux'] as const, resolution: '2K' as const };
    const migrated = currentDraft({ ...legacy, models: [...legacy.models] });
    expect(migrated.models).toEqual(['banana', 'gptSunburst']);
    expect(migrated.resolution).toBe('2K');
    expect(legacy.models).toEqual(['flux']);
    expect(models.flux.air).toBe('bfl:5@1');
    expect(currentDraft({ ...newDraft(), models: ['flux', 'muse'] }).models).toEqual(['muse']);
    expect(modelsFor('image')).toHaveLength(5);
    expect(modelsFor('image')).not.toContain('flux');
    const saved = {
      ...newDraft(),
      models: ['grok', 'muse'],
      grokQuality: 'low',
      grokResolution: '2K',
    };
    expect(draftSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it('prices Grok quality, resolution and each reference, and Muse at a fixed output rate', () => {
    const rates = [
      { amount: 0.04, unit: 'output', label: 'quality low · 1K' },
      { amount: 0.06, unit: 'output', label: 'quality medium · 1K' },
      { amount: 0.06, unit: 'output', label: 'quality low · 2K' },
      { amount: 0.08, unit: 'output', label: 'quality medium · 2K' },
      { amount: 0.01, unit: 'inputImage' },
    ];
    expect(calculateModelEstimate('grok', newDraft(), rates)).toBe(0.06);
    expect(
      calculateModelEstimate(
        'grok',
        { ...newDraft(), grokResolution: '2K', refs: ['a', 'b', 'c'] },
        rates,
      ),
    ).toBeCloseTo(0.11);
    expect(
      calculateModelEstimate(
        'grok',
        { ...newDraft(), grokQuality: 'low', grokResolution: '2K' },
        rates,
      ),
    ).toBe(0.06);
    expect(
      calculateModelEstimate('grok', { ...newDraft(), refs: ['a'] }, rates.slice(0, 4)),
    ).toBeNull();
    expect(
      calculateModelEstimate('muse', { ...newDraft(), refs: ['a', 'b'] }, [
        { amount: 0.01, unit: 'output' },
      ]),
    ).toBe(0.01);
  });
});
