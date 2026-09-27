export const chatModelIds = ['gpt', 'gemini', 'claude', 'deepseek', 'glm', 'kimi'] as const;
export type ChatModelId = (typeof chatModelIds)[number];

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  text?: string;
  imageIds: string[];
}
export interface ChatSource {
  title: string;
  url: string;
}
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  sources?: ChatSource[];
  author?: string;
}
export type ChatAnswerStatus =
  'queued' | 'streaming' | 'complete' | 'stopped' | 'failed' | 'interrupted';
export interface ChatAnswer {
  id: string;
  taskUUID: string;
  text: string;
  status: ChatAnswerStatus;
  sources: ChatSource[];
  cost?: number;
  error?: string;
  createdAt: number;
}
export interface ChatTurn {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  search: boolean;
  createdAt: number;
  answers: Partial<Record<ChatModelId, ChatAnswer[]>>;
  selectedAnswers: Partial<Record<ChatModelId, string>>;
}
export interface ChatSession {
  id: string;
  title: string;
  models: ChatModelId[];
  createdAt: number;
  updatedAt: number;
  seed: ChatHistoryMessage[];
  turns: ChatTurn[];
  draft: string;
  draftAttachments: ChatAttachment[];
  search: boolean;
  fork?: { sessionId: string; model: ChatModelId; turnId: string };
}
export const isChatAnswerActive = (answer: ChatAnswer) =>
  answer.status === 'queued' || answer.status === 'streaming';
export const isChatSessionActive = (session: ChatSession) =>
  session.turns.some((turn) =>
    Object.values(turn.answers).some((versions) => versions?.some(isChatAnswerActive)),
  );
export function selectedChatAnswer(turn: ChatTurn, model: ChatModelId) {
  const versions = turn.answers[model] ?? [];
  return versions.find((answer) => answer.id === turn.selectedAnswers[model]) ?? versions.at(-1);
}
export function chatHistory(
  session: ChatSession,
  model: ChatModelId,
  through?: string,
): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = structuredClone(session.seed);
  for (const turn of session.turns) {
    messages.push({ role: 'user', content: turn.text, attachments: turn.attachments });
    const answer = selectedChatAnswer(turn, model);
    if (answer?.text)
      messages.push({
        role: 'assistant',
        content: answer.text,
        sources: answer.sources,
        author: model,
      });
    if (turn.id === through) break;
  }
  return messages;
}
