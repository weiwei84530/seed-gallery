export const modelIds = [
  'banana',
  'gpt',
  'gptFlare',
  'gptSunburst',
  'flux',
  'seedream',
  'kling',
  'seedance',
  'omni',
  'wan',
  'minimax',
  'seedance25',
  'veo',
] as const;
export type ModelId = (typeof modelIds)[number];
export type WorkKind = 'image' | 'video';
export type Ratio = 'portrait' | 'square' | 'landscape';
export const videoResolutions = ['360p', '480p', '720p', '768p', '1080p', '1440p'] as const;
export type VideoResolution = (typeof videoResolutions)[number];
export interface Draft {
  kind?: WorkKind;
  prompt: string;
  models: ModelId[];
  ratio: Ratio;
  resolution: '1K' | '2K';
  count: number;
  refs: string[];
  googleSearch: boolean;
  gptQuality: 'auto' | 'low' | 'medium' | 'high';
  gptBackground: 'auto' | 'opaque' | 'transparent';
  seedreamThinking?: boolean;
  duration?: number;
  videoResolution?: '720p' | '1080p';
  videoResolutions?: Partial<Record<ModelId, VideoResolution>>;
  audio?: boolean;
  videoAudio?: Partial<Record<ModelId, boolean>>;
  klingNegativePrompt?: string;
}
export interface Work {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  draft: Draft;
}
export type JobStatus =
  'queued' | 'sending' | 'processing' | 'unknown' | 'retrieval_failed' | 'failed' | 'succeeded';
export interface Job {
  id: string;
  workId: string;
  batchId: string;
  model: ModelId;
  status: JobStatus;
  createdAt: number;
  draft: Draft;
  keyTag: string;
  mediaId?: string;
  cost?: number;
  message?: string;
  failureReason?: 'credits';
}
export interface Media {
  id: string;
  blob: Blob;
  name: string;
}
export interface Preferences {
  showMoney: boolean;
  balanceLimit: number;
  chatSystemPrompt?: string;
}
export interface Balance {
  amount: number;
  freeBalance?: number;
  currency: string;
}
export const newDraft = (): Draft => ({
  prompt: '',
  models: ['banana', 'gptSunburst'],
  ratio: 'portrait',
  resolution: '1K',
  count: 1,
  refs: [],
  googleSearch: false,
  gptQuality: 'auto',
  gptBackground: 'auto',
});
export const isActive = (job: Job) => ['queued', 'sending', 'processing'].includes(job.status);
export const isVideo = (draft: Draft) => draft.kind === 'video';
export const newVideoDraft = (): Draft => ({
  ...newDraft(),
  kind: 'video',
  models: ['kling'],
  duration: 4,
  videoResolutions: {},
  audio: true,
  videoAudio: {},
  klingNegativePrompt: '',
});
