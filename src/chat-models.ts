import type { ChatHistoryMessage, ChatModelId } from './chat-types';

export const selectableChatModelIds = [
  'gpt6Sol',
  'gemini38Flash',
  'opus55',
  'deepseek',
  'minimaxM3',
] as const;
export const maxSelectedChatModels = 3;

// Runware catalog rates, verified 2026-10-01. USD per million tokens.
// GPT-6 Sol tiers change above 272K context; MiniMax M3 above 512K.
export const chatTokenPrices: Partial<
  Record<ChatModelId, { input: string; output: string; source: string }>
> = {
  gpt6Sol: { input: '2–4', output: '10–15', source: 'https://runware.ai/pricing#models' },
  gemini38Flash: { input: '0.75', output: '3.75', source: 'https://runware.ai/pricing#models' },
  minimaxM3: {
    input: '0.30–0.60',
    output: '1.20–2.40',
    source: 'https://runware.ai/models/minimax-m3',
  },
  deepseek: { input: '0.15', output: '0.60', source: 'https://runware.ai/pricing#models' },
  opus48: {
    input: '5',
    output: '25',
    source: 'https://runware.ai/models/anthropic-claude-opus-4-8',
  },
  opus55: {
    input: '4',
    output: '20',
    source: 'https://runware.ai/models/anthropic-claude-opus-5-5',
  },
};

export const chatModels: Record<
  ChatModelId,
  {
    id: ChatModelId;
    name: string;
    family: string;
    air: string;
    description: string;
    images: boolean;
    search: boolean;
  }
> = {
  gpt6Sol: {
    id: 'gpt6Sol',
    name: 'GPT-6 Sol',
    family: 'GPT',
    air: 'openai:gpt@6-sol',
    description: '擅長深入分析，可查詢網路資料',
    images: true,
    search: true,
  },
  gemini38Flash: {
    id: 'gemini38Flash',
    name: 'Gemini 3.8 Flash',
    family: 'Gemini',
    air: 'google:gemini@3.8-flash',
    description: '日常問答，兼顧速度與品質',
    images: true,
    search: false,
  },
  minimaxM3: {
    id: 'minimaxM3',
    name: 'MiniMax M3',
    family: 'MiniMax',
    air: 'minimax:m3@0',
    description: '複雜推理與深入問答',
    images: true,
    search: false,
  },
  opus48: {
    id: 'opus48',
    name: 'Claude Opus 4.8',
    family: 'Claude',
    air: 'anthropic:claude@opus-4.8',
    description: '深入分析與長篇問答',
    images: true,
    search: false,
  },
  opus55: {
    id: 'opus55',
    name: 'Claude Opus 5.5',
    family: 'Claude',
    air: 'anthropic:claude@opus-5.5',
    description: '擅長長篇分析與複雜推理',
    images: true,
    search: false,
  },
  gpt54: {
    id: 'gpt54',
    name: 'GPT-5.4',
    family: 'GPT',
    air: 'openai:gpt@5.4',
    description: '擅長分析、圖片與文件問答',
    images: true,
    search: true,
  },
  geminiFlash: {
    id: 'geminiFlash',
    name: 'Gemini 3 Flash',
    family: 'Gemini',
    air: 'google:gemini@3-flash',
    description: '兼顧速度與品質，可看圖及文件',
    images: true,
    search: true,
  },
  gpt: {
    id: 'gpt',
    name: 'GPT-5.4 Mini',
    family: 'GPT',
    air: 'openai:gpt@5.4-mini',
    description: '快速且具影像理解能力',
    images: true,
    search: true,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini 3.1 Flash Lite',
    family: 'Gemini',
    air: 'google:gemini@3.1-flash-lite',
    description: '快速且節省費用的多模態模型',
    images: true,
    search: true,
  },
  claude: {
    id: 'claude',
    name: 'Claude Haiku 4.5',
    family: 'Claude',
    air: 'anthropic:claude@haiku-4.5',
    description: '適合日常文字與圖片討論',
    images: true,
    search: false,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek V4.1 Flash',
    family: 'DeepSeek',
    air: 'deepseek:v4.1@flash',
    description: '快速推理，費用實惠',
    images: true,
    search: false,
  },
  glm: {
    id: 'glm',
    name: 'GLM-5.3 Flash',
    family: 'GLM',
    air: 'zai:glm@5.3-flash',
    description: '適合文字分析與圖片理解',
    images: true,
    search: false,
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi K2.6',
    family: 'Kimi',
    air: 'moonshotai:kimi@k2.6',
    description: '適合長篇文字與圖片理解',
    images: true,
    search: false,
  },
};

export function validateChatRequest(
  models: ChatModelId[],
  history: ChatHistoryMessage[],
  search: boolean,
): string | null {
  if (
    !models.length ||
    models.length > maxSelectedChatModels ||
    new Set(models).size !== models.length ||
    models.some((id) => !chatModels[id])
  )
    return '請選擇一至三個模型。';
  if (!history.length || history.at(-1)?.role !== 'user') return '請先輸入訊息。';
  if (history.some((message) => !['user', 'assistant'].includes(message.role)))
    return '對話紀錄格式不正確。';
  if (
    history.some(
      (message) => message.role === 'assistant' && (message.attachments?.length ?? 0) > 0,
    )
  )
    return '目前不支援助理訊息中的附件。';
  if (history.some((message) => !message.content.trim() && !message.attachments?.length))
    return '訊息內容不可為空白。';
  if (search && models.some((id) => !chatModels[id].search)) return '所選模型不支援網路搜尋。';
  const imageTurns = history.filter((message) =>
    message.attachments?.some((attachment) => attachment.imageIds.length),
  );
  const characters = history.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.attachments ?? []).reduce((total, item) => total + (item.text?.length ?? 0), 0),
    0,
  );
  if (characters > 120_000) return '對話與附件合計超過 12 萬字，請精簡附件或開新對話。';
  const imageCount = history.reduce(
    (sum, message) =>
      sum + (message.attachments ?? []).reduce((total, item) => total + item.imageIds.length, 0),
    0,
  );
  if (imageCount > 20) return '對話最多包含 20 張圖片或文件頁面，請開新對話或減少附件。';
  if (imageTurns.length && models.some((id) => !chatModels[id].images))
    return '所選模型不支援圖片附件。';
  if (
    history.some((message) =>
      message.attachments?.some(
        (attachment) => !attachment.imageIds.length && !attachment.text?.trim(),
      ),
    )
  )
    return '附件沒有可讀取的內容，請重新上傳。';
  return null;
}
