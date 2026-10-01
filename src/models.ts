import { isVideo, type Draft, type ModelId, type VideoResolution, type WorkKind } from './types';

export const models = {
  grok: {
    kind: 'image',
    name: 'Grok Imagine Image 2.0',
    maker: 'XAI',
    air: 'xai:grok-imagine@image-2.0',
    note: '文字設計・靈活改圖',
    letter: 'G',
  },
  muse: {
    kind: 'image',
    name: 'Muse Image',
    maker: 'META',
    air: 'meta:muse@image',
    note: '細緻創作・2K 圖片',
    letter: 'M',
  },
  banana: {
    kind: 'image',
    name: 'Nano Banana 2',
    maker: 'GOOGLE',
    air: 'google:4@3',
    note: '自然光影・靈活改圖',
    letter: 'N',
  },
  gpt: {
    kind: 'image',
    name: 'GPT Image 2',
    maker: 'OPENAI',
    air: 'openai:gpt-image@2',
    note: '細膩構圖・文字設計',
    letter: 'G',
  },
  flux: {
    kind: 'image',
    name: 'FLUX.2 Pro',
    maker: 'BLACK FOREST LABS',
    air: 'bfl:5@1',
    note: '寫實質感・商品攝影',
    letter: 'F',
  },
  gptFlare: {
    kind: 'image',
    name: 'GPT Image 2.5 Flare',
    maker: 'OPENAI',
    air: 'openai:gpt-image@2.5-flare',
    note: '快速創作・細膩改圖',
    letter: 'G',
  },
  gptSunburst: {
    kind: 'image',
    name: 'GPT Image 2.5 Sunburst',
    maker: 'OPENAI',
    air: 'openai:gpt-image@2.5-sunburst',
    note: '精準改圖・細膩構圖',
    letter: 'G',
  },
  seedream: {
    kind: 'image',
    name: 'Seedream 5.0 Pro',
    maker: 'BYTEDANCE',
    air: 'bytedance:seedream@5.0-pro',
    note: '構圖設計・多圖修改',
    letter: 'S',
  },
  kling: {
    kind: 'video',
    name: 'Kling 3.0 Standard',
    maker: 'KLING AI',
    air: 'klingai:kling-video@3-standard',
    note: '動作自然・日常創作',
    letter: 'K',
  },
  seedance: {
    kind: 'video',
    name: 'Seedance 2.0 Fast',
    maker: 'BYTEDANCE',
    air: 'bytedance:seedance@2.0-fast',
    note: '快速創作・豐富動態',
    letter: 'S',
  },
  omni: {
    kind: 'video',
    name: 'Gemini Omni Flash 1.1',
    maker: 'GOOGLE',
    air: 'google:gemini@omni-flash-1.1',
    note: '快速預覽・原生有聲',
    letter: 'G',
  },
  wan: {
    kind: 'video',
    name: 'Wan 3.0',
    maker: 'ALIBABA',
    air: 'alibaba:wan@3.0',
    note: '日常創作・聲畫同步',
    letter: 'W',
  },
  minimax: {
    kind: 'video',
    name: 'MiniMax H3',
    maker: 'MINIMAX',
    air: 'minimax:h3@0',
    note: '細膩動態・原生有聲',
    letter: 'M',
  },
  seedance25: {
    kind: 'video',
    name: 'Seedance 2.5',
    maker: 'BYTEDANCE',
    air: 'bytedance:seedance@2.5',
    note: '豐富動態・480p 創作',
    letter: 'S',
  },
  veo: {
    kind: 'video',
    name: 'Veo 3.1 Fast',
    maker: 'GOOGLE',
    air: 'google:3@3',
    note: '光影氛圍・聲音場景',
    letter: 'V',
  },
} as const;

export const modelsFor = (kind: WorkKind) =>
  (Object.keys(models) as ModelId[]).filter(
    (id) => !['gpt', 'gptFlare', 'veo', 'flux'].includes(id) && models[id].kind === kind,
  );

// Veo remains readable for historical jobs and backups, but is no longer offered.
export function videoResolutionOptions(model: ModelId): VideoResolution[] {
  switch (model) {
    case 'omni':
      return ['360p', '720p'];
    case 'wan':
    case 'seedance':
      return ['480p', '720p'];
    case 'minimax':
      return ['768p', '1440p'];
    case 'seedance25':
      return ['480p'];
    case 'veo':
      return ['720p', '1080p'];
    case 'kling':
      return ['720p'];
    default:
      return [];
  }
}

export function videoResolutionFor(model: ModelId, draft: Draft): VideoResolution {
  const saved = draft.videoResolutions?.[model] ?? draft.videoResolution;
  if (saved) return saved;
  return model === 'minimax' ? '768p' : model === 'seedance25' ? '480p' : '720p';
}

export const fixedVideoAudio = (model: ModelId) => model === 'omni' || model === 'minimax';
export const videoAudioFor = (model: ModelId, draft: Draft) =>
  fixedVideoAudio(model) || (draft.videoAudio?.[model] ?? draft.audio ?? true);
export const supportsSquareVideo = (model: ModelId) => model !== 'omni' && model !== 'veo';

// Upgrade editable selections while preserving historical jobs and their model identity.
export function currentDraft(draft: Draft): Draft {
  const next: Draft = {
    ...draft,
    models: [
      ...new Set(
        draft.models
          .filter((id) => id !== 'veo' && id !== 'flux')
          .map((id) => (id === 'gpt' || id === 'gptFlare' ? ('gptSunburst' as const) : id)),
      ),
    ],
  };
  if (!isVideo(next)) {
    if (!next.models.length && draft.models.includes('flux'))
      next.models = ['banana', 'gptSunburst'];
    next.grokQuality = draft.grokQuality ?? 'medium';
    next.grokResolution = draft.grokResolution ?? draft.resolution;
  }
  if (isVideo(next)) {
    if (!next.models.length && draft.models.includes('veo')) next.models = ['kling'];
    next.videoResolutions = { ...draft.videoResolutions };
    for (const model of next.models) {
      const saved = draft.videoResolutions?.[model] ?? draft.videoResolution;
      next.videoResolutions[model] =
        saved && videoResolutionOptions(model).includes(saved)
          ? saved
          : videoResolutionFor(model, {
              ...next,
              videoResolution: undefined,
              videoResolutions: {},
            });
    }
    delete next.videoResolution;
    // The new per-model controls start with audio enabled; historical jobs keep their settings.
    next.videoAudio = { ...draft.videoAudio };
    delete next.audio;
  }
  return next;
}
export const promptLimit = (draft: Draft) =>
  Math.min(
    ...draft.models.map((m) =>
      m === 'kling'
        ? 2500
        : ['seedream', 'veo'].includes(m)
          ? 3000
          : m === 'seedance'
            ? 10000
            : m === 'minimax'
              ? 7000
              : m === 'wan'
                ? 20000
                : 32000,
    ),
    32000,
  );
export function dimensions(model: ModelId, draft: Draft) {
  if (model === 'muse') {
    return draft.ratio === 'square'
      ? { width: 1600, height: 1600 }
      : draft.ratio === 'portrait'
        ? { width: 1152, height: 2048 }
        : { width: 2048, height: 1152 };
  }
  if (model === 'grok') {
    const large = (draft.grokResolution ?? draft.resolution) === '2K';
    const size =
      draft.ratio === 'square'
        ? large
          ? [2048, 2048]
          : [1024, 1024]
        : large
          ? [1584, 2816]
          : [720, 1280];
    return draft.ratio === 'landscape'
      ? { width: size[1], height: size[0] }
      : { width: size[0], height: size[1] };
  }
  if (models[model].kind === 'video') {
    const resolution = videoResolutionFor(model, draft);
    const landscape =
      resolution === '360p'
        ? [640, 360]
        : resolution === '480p'
          ? model === 'wan'
            ? [832, 480]
            : model === 'seedance25'
              ? [854, 480]
              : [864, 496]
          : resolution === '768p'
            ? [1344, 768]
            : resolution === '1440p'
              ? [2560, 1440]
              : resolution === '1080p'
                ? [1920, 1080]
                : [1280, 720];
    if (draft.ratio === 'square') {
      const size =
        resolution === '480p'
          ? model === 'wan'
            ? 624
            : 640
          : resolution === '768p'
            ? 768
            : resolution === '1440p'
              ? 1440
              : 960;
      return { width: size, height: size };
    }
    return draft.ratio === 'portrait'
      ? { width: landscape[1], height: landscape[0] }
      : { width: landscape[0], height: landscape[1] };
  }
  if (model === 'seedream' && draft.ratio !== 'square') {
    const size = draft.resolution === '2K' ? [1584, 2816] : [800, 1424];
    return draft.ratio === 'portrait'
      ? { width: size[0], height: size[1] }
      : { width: size[1], height: size[0] };
  }
  if (model === 'flux' && draft.resolution === '2K' && draft.ratio !== 'square')
    return draft.ratio === 'portrait'
      ? { width: 1152, height: 2048 }
      : { width: 2048, height: 1152 };
  const portrait = model === 'banana' ? [768, 1376] : [768, 1360];
  const size =
    draft.ratio === 'square'
      ? [1024, 1024]
      : draft.ratio === 'portrait'
        ? portrait
        : [...portrait].reverse();
  const scale = draft.resolution === '2K' ? 2 : 1;
  return { width: size[0] * scale, height: size[1] * scale };
}

export function validateDraft(draft: Draft) {
  if (draft.prompt.trim().length < 3) throw new Error('請用至少 3 個字描述想要的畫面。');
  if (draft.prompt.length > 32000) throw new Error('描述太長了，請縮短至 32,000 字以內。');
  if (
    !draft.models.length ||
    new Set(draft.models).size !== draft.models.length ||
    draft.models.some((m) => !models[m])
  )
    throw new Error('請至少選擇一個模型。');
  if (!Number.isInteger(draft.count) || draft.count < 1 || draft.count > 4)
    throw new Error('每個模型可生成 1 至 4 張。');
  if (draft.refs.length > 4) throw new Error('每次最多使用 4 張參考照片。');
  if (draft.models.includes('grok') && draft.refs.length > 3)
    throw new Error('Grok 最多使用 3 張參考照片，請移除一張照片或更換模型。');
  if (draft.models.some((m) => models[m].kind !== (draft.kind ?? 'image')))
    throw new Error('請選擇符合這份作品類別的模型。');
  if (draft.prompt.length > promptLimit(draft))
    throw new Error(`目前模型最多接受 ${promptLimit(draft).toLocaleString()} 字，請縮短描述。`);
  if (isVideo(draft)) {
    if (draft.refs.length > 1) throw new Error('影片每次使用一張起始照片。');
    if (![4, 6, 8].includes(draft.duration ?? 4)) throw new Error('請選擇 4、6 或 8 秒。');
    if (draft.count > 2) throw new Error('每個模型每次最多生成 2 支影片。');
    for (const model of draft.models) {
      if (draft.ratio === 'square' && !supportsSquareVideo(model) && !draft.refs.length)
        throw new Error(`${models[model].name} 支援直向與橫向影片，請更換比例。`);
      if (!videoResolutionOptions(model).includes(videoResolutionFor(model, draft)))
        throw new Error(
          `${models[model].name} 支援 ${videoResolutionOptions(model).join('、')}，請調整解析度。`,
        );
    }
    const negativeLength = draft.klingNegativePrompt?.trim().length ?? 0;
    if (draft.models.includes('kling') && negativeLength === 1)
      throw new Error('Kling 排除內容請至少填寫 2 個字，或保持空白。');
    if (negativeLength > 2500) throw new Error('Kling 排除內容最多 2,500 字。');
  }
}

export interface GenerationRequest {
  taskType: string;
  taskUUID: string;
  model: string;
  positivePrompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  duration?: number;
  resolution?: string;
  numberResults: number;
  outputType: string;
  outputFormat: string;
  deliveryMethod: string;
  includeCost: boolean;
  inputs?: { referenceImages?: string[]; frameImages?: { image: string; frame: string }[] };
  providerSettings?: Record<string, Record<string, string | boolean>>;
  settings?: Record<string, string | boolean>;
}

export function buildRequest(
  id: string,
  model: ModelId,
  draft: Draft,
  references: string[],
): GenerationRequest {
  validateDraft(draft);
  if (references.length !== draft.refs.length)
    throw new Error('參考照片尚未完整載入，請重新選擇照片。');
  if (isVideo(draft))
    return {
      taskType: 'videoInference',
      taskUUID: id,
      model: models[model].air,
      positivePrompt: draft.prompt.trim(),
      duration: draft.duration ?? 4,
      numberResults: 1,
      outputType: 'URL',
      outputFormat: 'MP4',
      deliveryMethod: 'async',
      includeCost: true,
      ...(references.length
        ? {
            inputs: { frameImages: [{ image: references[0], frame: 'first' }] },
            ...(model !== 'kling' ? { resolution: videoResolutionFor(model, draft) } : {}),
          }
        : dimensions(model, draft)),
      ...(model === 'kling'
        ? {
            providerSettings: { klingai: { sound: videoAudioFor(model, draft) } },
            ...(draft.klingNegativePrompt?.trim()
              ? { negativePrompt: draft.klingNegativePrompt.trim() }
              : {}),
          }
        : ['seedance', 'seedance25', 'wan'].includes(model)
          ? { settings: { audio: videoAudioFor(model, draft) } }
          : model === 'veo'
            ? {
                providerSettings: {
                  google: {
                    generateAudio: videoAudioFor(model, draft),
                    ...(references.length ? { resizeMode: 'pad' } : {}),
                  },
                },
              }
            : {}),
    };
  return {
    taskType: 'imageInference',
    taskUUID: id,
    model: models[model].air,
    positivePrompt: draft.prompt.trim(),
    ...(references.length && (model === 'grok' || model === 'muse')
      ? { resolution: model === 'muse' ? '2K' : (draft.grokResolution ?? draft.resolution) }
      : dimensions(model, draft)),
    numberResults: 1,
    outputType: 'dataURI',
    outputFormat: 'PNG',
    deliveryMethod: 'async',
    includeCost: true,
    ...(references.length ? { inputs: { referenceImages: references } } : {}),
    ...(model === 'grok'
      ? { settings: { quality: draft.grokQuality ?? 'medium' } }
      : model === 'muse'
        ? { settings: { thinkingLevel: 'high', webSearch: false, imageSearch: false, shell: true } }
        : model === 'banana'
          ? { providerSettings: { google: { webSearch: draft.googleSearch } } }
          : model === 'gptSunburst' || model === 'gptFlare'
            ? { settings: { quality: draft.gptQuality, background: draft.gptBackground } }
            : model === 'gpt'
              ? {
                  providerSettings: { openai: { quality: draft.gptQuality } },
                  settings: { background: draft.gptBackground },
                }
              : model === 'seedream'
                ? { settings: { thinking: draft.seedreamThinking ?? true } }
                : {}),
  };
}
