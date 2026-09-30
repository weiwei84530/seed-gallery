export const modelIds = [
  'banana',
  'gpt',
  'gptFlare',
  'gptSunburst',
  'flux',
  'seedream',
  'kling',
  'seedance',
  'veo',
] as const;
export type ModelId = (typeof modelIds)[number];
export type WorkKind = 'image' | 'video';
export type Ratio = 'portrait' | 'square' | 'landscape';
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
  audio?: boolean;
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
  | 'queued'
  | 'sending'
  | 'processing'
  | 'unknown'
  | 'retrieval_failed'
  | 'failed'
  | 'succeeded';
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
}
export interface Media {
  id: string;
  blob: Blob;
  name: string;
}
export interface Preferences {
  showMoney: boolean;
  balanceLimit: number;
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
  videoResolution: '720p',
  audio: false,
  klingNegativePrompt: '',
});
