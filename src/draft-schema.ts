import { z } from 'zod';
import { modelIds, videoResolutions } from './types';

export const draftSchema = z.object({
  kind: z.enum(['image', 'video']).optional(),
  prompt: z.string().max(32000),
  models: z.array(z.enum(modelIds)).max(6),
  ratio: z.enum(['portrait', 'square', 'landscape']),
  resolution: z.enum(['1K', '2K']),
  count: z.number().int().min(1).max(4),
  refs: z.array(z.string().uuid()).max(4),
  googleSearch: z.boolean(),
  gptQuality: z.enum(['auto', 'low', 'medium', 'high']),
  gptBackground: z.enum(['auto', 'opaque', 'transparent']),
  seedreamThinking: z.boolean().optional(),
  grokQuality: z.enum(['low', 'medium']).optional(),
  grokResolution: z.enum(['1K', '2K']).optional(),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(),
  videoResolution: z.enum(['720p', '1080p']).optional(),
  videoResolutions: z.partialRecord(z.enum(modelIds), z.enum(videoResolutions)).optional(),
  audio: z.boolean().optional(),
  videoAudio: z.partialRecord(z.enum(modelIds), z.boolean()).optional(),
  klingNegativePrompt: z.string().max(2500).optional(),
});
