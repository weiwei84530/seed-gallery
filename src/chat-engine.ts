import { getChatSession, listChatSessions, updateChatSession } from './chat-db';
import { streamChat, validateChatRequest } from './chat-api';
import {
  chatHistory,
  isChatSessionActive,
  type ChatAnswer,
  type ChatAttachment,
  type ChatModelId,
  type ChatSession,
} from './chat-types';

const controllers = new Map<string, AbortController>();
const lockName = (id: string) => `seed-gallery.chat.${id}`;
export function stopChat(sessionId: string, model?: ChatModelId) {
  for (const [id, controller] of controllers) {
    if (id.startsWith(`${sessionId}:`) && (!model || id === `${sessionId}:${model}`))
      controller.abort();
  }
  channel?.postMessage({ sessionId, model });
}
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('seed-gallery.chat-stop') : null;
if (channel)
  channel.onmessage = ({ data }: MessageEvent<{ sessionId: string; model?: ChatModelId }>) => {
    for (const [id, controller] of controllers) {
      if (
        id.startsWith(`${data.sessionId}:`) &&
        (!data.model || id === `${data.sessionId}:${data.model}`)
      )
        controller.abort();
    }
  };

function answerRecord(): ChatAnswer {
  return {
    id: crypto.randomUUID(),
    taskUUID: crypto.randomUUID(),
    text: '',
    status: 'queued',
    sources: [],
    createdAt: Date.now(),
  };
}

export async function recoverChatSessions() {
  const sessions = await listChatSessions();
  await Promise.all(
    sessions.filter(isChatSessionActive).map((session) => recoverChatSession(session.id)),
  );
}

export async function recoverChatSession(id: string) {
  if (!navigator.locks) return;
  await navigator.locks.request(lockName(id), { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const session = await getChatSession(id);
    if (!session || !isChatSessionActive(session)) return;
    await updateChatSession(id, (value) => {
      for (const turn of value.turns)
        for (const versions of Object.values(turn.answers)) {
          for (const answer of versions ?? [])
            if (['queued', 'streaming'].includes(answer.status)) {
              answer.status = 'interrupted';
              answer.error = '連線已中斷，已保留收到的內容。重新回答會建立新的付費請求。';
            }
        }
    });
  });
}

async function runModel(session: ChatSession, model: ChatModelId, key: string) {
  const turn = session.turns.at(-1)!;
  const answer = turn.answers[model]!.at(-1)!;
  const controller = new AbortController();
  const controllerId = `${session.id}:${model}`;
  controllers.set(controllerId, controller);
  let latest = { text: '', sources: answer.sources, cost: undefined as number | undefined };
  let lastSaved = 0;
  let writes = Promise.resolve();
  let persistenceError = false;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 300_000);
  const save = (status: ChatAnswer['status'], error?: string) => {
    const snapshot = { ...latest };
    writes = writes
      .then(async () => {
        await updateChatSession(session.id, (value) => {
          const record = value.turns
            .find((item) => item.id === turn.id)
            ?.answers[model]?.find((item) => item.id === answer.id);
          if (!record) throw new Error('對話已不存在，停止接收回答。');
          Object.assign(record, snapshot, { status, error });
          value.updatedAt = Date.now();
        });
      })
      .catch(() => {
        persistenceError = true;
        controller.abort();
        window.dispatchEvent(new Event('chat-storage-error'));
      });
    return writes;
  };
  try {
    await save('streaming');
    if (persistenceError) throw new Error('無法保存回答，請檢查儲存空間。');
    // The current answer is empty; previous versions must not become its own input.
    const messages = chatHistory({ ...session, turns: session.turns.slice(0, -1) }, model);
    messages.push({ role: 'user', content: turn.text, attachments: turn.attachments });
    latest = await streamChat({
      key,
      model,
      messages,
      search: turn.search,
      taskUUID: answer.taskUUID,
      signal: controller.signal,
      onUpdate(update) {
        latest = { text: update.text, sources: update.sources, cost: update.cost };
        if (Date.now() - lastSaved >= 180) {
          lastSaved = Date.now();
          void save('streaming');
        }
      },
    });
    await save(controller.signal.aborted ? 'stopped' : 'complete');
  } catch (error) {
    await save(
      persistenceError || timedOut
        ? 'interrupted'
        : controller.signal.aborted
          ? 'stopped'
          : 'failed',
      persistenceError
        ? '無法保存回答，請檢查裝置儲存空間。'
        : timedOut
          ? '回答超過五分鐘，已停止接收並保留內容；服務商可能仍會計費。'
          : controller.signal.aborted
            ? '已停止接收；服務商可能仍完成請求並計費。'
            : error instanceof Error
              ? error.message
              : '回答未完成，可重新回答。',
    );
  } finally {
    window.clearTimeout(timeout);
    controllers.delete(controllerId);
    window.dispatchEvent(new Event('chat-finished'));
  }
}

export function sendChat(options: {
  sessionId: string;
  key: string;
  text: string;
  attachments: ChatAttachment[];
  search: boolean;
  retryModel?: ChatModelId;
}) {
  return new Promise<void>((resolve, reject) => {
    if (!navigator.locks) {
      reject(new Error('此瀏覽器不支援安全送出對話，請更新瀏覽器後再試。'));
      return;
    }
    if (!options.key) {
      reject(new Error('請先到設定輸入 Runware API Key。'));
      return;
    }
    if (!navigator.onLine) {
      reject(new Error('目前離線，請連線後再送出。'));
      return;
    }
    void navigator.locks
      .request(lockName(options.sessionId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('這份對話還在回答中，請等待或停止後再送出。');
        const current = await getChatSession(options.sessionId);
        if (!current) throw new Error('找不到這份對話。');
        if (isChatSessionActive(current)) throw new Error('請先確認中斷的回答狀態。');
        const targets = options.retryModel ? [options.retryModel] : current.models;
        if (targets.some((model) => !current.models.includes(model)))
          throw new Error('此對話的模型已固定。');
        const last = current.turns.at(-1);
        if (!options.retryModel && current.turns.length >= 150)
          throw new Error('這段對話已達 150 回合，請開新對話。');
        if (options.retryModel && (last?.answers[options.retryModel]?.length ?? 0) >= 20)
          throw new Error('同一則回答最多保存 20 個版本，請建立分支再繼續。');
        if (options.retryModel && !last) throw new Error('沒有可重新回答的問題。');
        const text = options.retryModel ? last!.text : options.text.trim();
        const attachments = options.retryModel ? last!.attachments : options.attachments;
        const search = options.retryModel ? last!.search : options.search;
        if (!text && !attachments.length) throw new Error('請輸入問題或加入附件。');
        if (text.length > 24000) throw new Error('單次問題請控制在 24,000 字以內。');
        for (const model of targets) {
          const base = options.retryModel
            ? { ...current, turns: current.turns.slice(0, -1) }
            : current;
          const messages = [
            ...chatHistory(base, model),
            { role: 'user' as const, content: text, attachments },
          ];
          const problem = validateChatRequest([model], messages, search);
          if (problem) throw new Error(problem);
        }
        const session = await updateChatSession(current.id, (value) => {
          if (isChatSessionActive(value)) throw new Error('這份對話正在回答。');
          if (options.retryModel) {
            const turn = value.turns.at(-1)!;
            const record = answerRecord();
            (turn.answers[options.retryModel] ??= []).push(record);
            turn.selectedAnswers[options.retryModel] = record.id;
          } else {
            const answers = Object.fromEntries(
              value.models.map((model) => [model, [answerRecord()]]),
            );
            value.turns.push({
              id: crypto.randomUUID(),
              text,
              attachments,
              search,
              createdAt: Date.now(),
              answers,
              selectedAnswers: {},
            });
            if (!value.turns.slice(0, -1).length && !value.seed.length)
              value.title = (text || attachments[0]?.name || '新對話').slice(0, 48);
            value.draft = '';
            value.draftAttachments = [];
            value.search = search;
          }
          value.updatedAt = Date.now();
        });
        resolve();
        await Promise.allSettled(targets.map((model) => runModel(session, model, options.key)));
      })
      .catch(reject);
  });
}
