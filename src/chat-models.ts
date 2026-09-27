import type { ChatHistoryMessage, ChatModelId } from './chat-types';

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
    description: '適合文字推理與圖片理解',
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
    models.length > 3 ||
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
