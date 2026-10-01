import {
  dimensions,
  models,
  supportsSquareVideo,
  videoAudioFor,
  videoResolutionFor,
  videoResolutionOptions,
} from './models';
import { isVideo, type Draft, type ModelId } from './types';

export interface PricingRate {
  amount: number;
  unit: string;
  label?: string;
  after?: number;
}

interface PricingResponse {
  air: string;
  pricingRates?: PricingRate[];
}

const pricingCache = new Map<ModelId, Promise<PricingRate[] | null>>();

async function fetchRates(model: ModelId) {
  const existing = pricingCache.get(model);
  if (existing) return existing;
  const request = fetch(
    `https://content.runware.ai/models/${encodeURIComponent(models[model].air)}/pricing`,
    { signal: AbortSignal.timeout(8000), credentials: 'omit', referrerPolicy: 'no-referrer' },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const data = (await response.json()) as PricingResponse;
      return data.air === models[model].air && Array.isArray(data.pricingRates)
        ? data.pricingRates
        : null;
    })
    .catch(() => null);
  pricingCache.set(model, request);
  return request;
}

const rate = (rates: PricingRate[], unit: string, label?: RegExp) =>
  rates.find(
    (item) =>
      Number.isFinite(item.amount) &&
      item.amount >= 0 &&
      item.unit === unit &&
      (!label || label.test(item.label ?? '')),
  )?.amount;

export function calculateModelEstimate(model: ModelId, draft: Draft, rates: PricingRate[]) {
  if (model === 'gpt' || model === 'gptFlare' || model === 'gptSunburst') return null;
  if (model === 'muse') return rate(rates, 'output') ?? null;
  if (model === 'grok') {
    const output = rate(
      rates,
      'output',
      new RegExp(
        `^quality ${draft.grokQuality ?? 'medium'} · ${draft.grokResolution ?? draft.resolution}$`,
        'i',
      ),
    );
    const input = rate(rates, 'inputImage');
    if (output === undefined || (draft.refs.length && input === undefined)) return null;
    return output + (input ?? 0) * draft.refs.length;
  }

  if (model === 'banana') {
    if (draft.googleSearch) return null;
    const output = rate(rates, 'output', new RegExp(`^${draft.resolution}$`, 'i'));
    const input = rate(rates, 'inputImage');
    if (output === undefined || (draft.refs.length > 0 && input === undefined)) return null;
    return output + (input ?? 0) * draft.refs.length;
  }

  if (model === 'flux') {
    if (draft.refs.length) return null;
    const first = rate(rates, 'outputMegapixel', /First megapixel/i);
    const additional = rate(rates, 'outputMegapixel', /Each further megapixel/i);
    if (first === undefined) return null;
    const size = dimensions(model, draft);
    // BFL's calculator bills whole 1024 x 1024 megapixels, with a separate first tier.
    const megapixels = Math.max(1, Math.ceil((size.width * size.height) / (1024 * 1024)));
    if (megapixels > 1 && additional === undefined) return null;
    return first + (megapixels - 1) * (additional ?? 0);
  }

  if (model === 'seedream') {
    const size = dimensions(model, draft);
    const label = size.width * size.height > 2_360_000 ? /^2K$/i : /^1\.5K$/i;
    const output = rate(rates, 'output', label);
    const extraInput = rate(rates, 'inputImage');
    if (output === undefined || (draft.refs.length > 1 && extraInput === undefined)) return null;
    return output + (extraInput ?? 0) * Math.max(0, draft.refs.length - 1);
  }

  if (isVideo(draft)) {
    if (model === 'omni') return null;
    const withAudio = videoAudioFor(model, draft);
    const resolution = videoResolutionFor(model, draft);
    const label =
      model === 'seedance' || model === 'wan'
        ? new RegExp(`^${resolution}$`, 'i')
        : model === 'minimax'
          ? new RegExp(`^${resolution === '1440p' ? '2K' : resolution}$`, 'i')
          : model === 'seedance25'
            ? new RegExp(`^Text/Image to Video · ${resolution}$`, 'i')
            : model === 'kling'
              ? withAudio
                ? /· audio$/i
                : /no audio/i
              : withAudio
                ? /with audio/i
                : /^720p \/ 1080p$/i;
    const perSecond = rate(rates, 'durationSecond', label);
    if (perSecond === undefined) return null;
    return perSecond * (draft.duration ?? 4);
  }

  return null;
}

export interface ModelEstimate {
  amount: number | null;
  reason?: string;
}

export async function estimateModelCost(model: ModelId, draft: Draft): Promise<ModelEstimate> {
  if (model === 'gpt' || model === 'gptFlare')
    return { amount: null, reason: '依實際用量計費，無法預估' };
  if (model === 'gptSunburst') return { amount: null, reason: '依 token 實際用量計費，無法預估' };
  if (model === 'omni') return { amount: null, reason: '依 token 實際用量計費，無法預估' };
  if (model === 'banana' && draft.googleSearch)
    return { amount: null, reason: '含網路搜尋，用量未定，暫無法預估' };
  if (model === 'flux' && draft.refs.length)
    return { amount: null, reason: '參考照片用量未定，暫無法預估' };
  if (
    isVideo(draft) &&
    ((!supportsSquareVideo(model) && draft.ratio === 'square' && !draft.refs.length) ||
      !videoResolutionOptions(model).includes(videoResolutionFor(model, draft)))
  )
    return { amount: null, reason: '不支援目前的比例或解析度' };
  const rates = await fetchRates(model);
  if (!rates) return { amount: null, reason: '暫時無法取得價格' };
  const amount = calculateModelEstimate(model, draft, rates);
  return { amount, ...(amount === null ? { reason: '目前設定尚無可用估價' } : {}) };
}
