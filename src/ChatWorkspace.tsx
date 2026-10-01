import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitFork,
  Globe,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageCircle,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  chatModels,
  chatTokenPrices,
  maxSelectedChatModels,
  selectableChatModelIds,
} from './chat-models';
import { listChatSessions, removeChatSession, saveChatSession, updateChatSession } from './chat-db';
import { prepareChatAttachment } from './chat-attachments';
import { recoverChatSession, sendChat, stopChat } from './chat-engine';
import {
  chatHistory,
  chatModelIds,
  isChatSessionActive,
  selectedChatAnswer,
  type ChatAttachment,
  type ChatHistoryMessage,
  type ChatModelId,
  type ChatMode,
  type ChatSession,
  type ChatTurn,
} from './chat-types';
import { getMedia } from './db';
import { download } from './media';
import openaiLogo from './assets/providers/openai.svg';
import googleLogo from './assets/providers/gemini.svg';
import minimaxLogo from './assets/providers/minimax.svg';
import deepseekLogo from './assets/providers/deepseek.svg';
import claudeLogo from './assets/providers/claude.svg';
import './chat.css';

export const CHAT_SELECTION_KEY = 'img-generator.chat-models';
const money = (value: number) => `US$ ${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
const chatProviderLogos: Partial<Record<ChatModelId, string>> = {
  gpt6Sol: openaiLogo,
  gemini38Flash: googleLogo,
  minimaxM3: minimaxLogo,
  deepseek: deepseekLogo,
  deepseekPro: deepseekLogo,
  opus48: claudeLogo,
  opus55: claudeLogo,
};
const statusText = {
  queued: '等待回答',
  streaming: '正在回答',
  complete: '回答完成',
  stopped: '已停止',
  failed: '回答未完成',
  interrupted: '連線中斷',
};
function rememberedModels(): ChatModelId[] {
  try {
    const models: unknown = JSON.parse(localStorage.getItem(CHAT_SELECTION_KEY) ?? 'null');
    if (
      Array.isArray(models) &&
      models.length >= 1 &&
      models.length <= maxSelectedChatModels &&
      new Set(models).size === models.length &&
      models.every((id) => chatModelIds.includes(id))
    )
      return upgradedSelection(models as ChatModelId[]);
  } catch {
    /* Use the default selection when storage is unavailable. */
  }
  return ['gpt6Sol', 'gemini38Flash'];
}
function upgradedSelection(models: readonly ChatModelId[]): ChatModelId[] {
  const upgraded = models
    .map((model) => {
      if (model === 'gpt' || model === 'gpt54') return 'gpt6Sol';
      if (model === 'gemini' || model === 'geminiFlash') return 'gemini38Flash';
      if (model === 'opus48') return 'opus55';
      if (model === 'deepseek') return 'deepseekPro';
      return model;
    })
    .filter((model): model is (typeof selectableChatModelIds)[number] =>
      (selectableChatModelIds as readonly string[]).includes(model),
    );
  return upgraded.length
    ? [...new Set(upgraded)].slice(0, maxSelectedChatModels)
    : ['gpt6Sol', 'gemini38Flash'];
}
function ModelMark({ model }: { model: ChatModelId }) {
  const logo = chatProviderLogos[model];
  return (
    <span
      className={`chat-model-mark ${chatModels[model].family.toLowerCase()}`}
      aria-hidden="true"
    >
      {logo ? <img src={logo} alt="" /> : chatModels[model].family.slice(0, 1)}
    </span>
  );
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="chat-action"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }
      aria-label={copied ? '已複製' : '複製內容'}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? '已複製' : '複製'}
    </button>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="chat-code">
      <button
        className="chat-action"
        onClick={() => void navigator.clipboard.writeText(ref.current?.textContent ?? '')}
      >
        複製程式碼
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={href && /^https?:\/\//i.test(href) ? href : undefined}
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span>[圖片：{alt || '外部圖片'}]</span>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
function AttachmentList({
  items,
  remove,
}: {
  items: ChatAttachment[];
  remove?: (id: string) => void;
}) {
  return (
    <div className="chat-attachments">
      {items.map((item) => (
        <span className="chat-attachment" key={item.id}>
          <button
            type="button"
            title="下載原始附件"
            onClick={() =>
              void getMedia(item.id).then((media) => {
                if (media) download(media.blob, item.name);
              })
            }
          >
            <Paperclip size={14} />
            <span>{item.name}</span>
          </button>
          {remove && (
            <button type="button" aria-label={`移除 ${item.name}`} onClick={() => remove(item.id)}>
              <X size={14} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
function Sources({ items }: { items: { title: string; url: string }[] }) {
  const safe = items.filter((source) => {
    try {
      return ['http:', 'https:'].includes(new URL(source.url).protocol);
    } catch {
      return false;
    }
  });
  return (
    safe.length > 0 && (
      <div className="chat-sources">
        <small>參考來源</small>
        {safe.map((source, index) => (
          <a
            key={`${source.url}-${index}`}
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {index + 1}. {source.title || new URL(source.url).hostname}
          </a>
        ))}
      </div>
    )
  );
}

function ChatPanel({
  model,
  expanded,
  hidden,
  single,
  revision,
  children,
  footer,
  onToggle,
  onStop,
}: {
  model: ChatModelId;
  expanded: boolean;
  hidden: boolean;
  single: boolean;
  revision: unknown;
  children: ReactNode;
  footer: ReactNode;
  onToggle: () => void;
  onStop?: () => void;
}) {
  const feed = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const splitPosition = useRef(0);
  const splitFollow = useRef(true);
  const adjusting = useRef(false);
  const wasExpanded = useRef(expanded);
  useLayoutEffect(() => {
    const node = feed.current;
    if (!node || hidden) return;
    adjusting.current = true;
    if (wasExpanded.current && !expanded) {
      follow.current = splitFollow.current;
      node.scrollTop = follow.current ? node.scrollHeight : splitPosition.current;
    } else if (follow.current) node.scrollTop = node.scrollHeight;
    wasExpanded.current = expanded;
    const frame = requestAnimationFrame(() => {
      adjusting.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, hidden, revision]);
  useEffect(() => {
    const node = feed.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (!hidden && follow.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hidden]);
  return (
    <section
      className={`chat-card ${expanded ? 'chat-expanded' : 'chat-preview'} ${hidden ? 'chat-card-hidden' : ''}`}
      aria-hidden={hidden}
      inert={hidden}
      aria-label={chatModels[model].name}
    >
      <div className="chat-panel-heading">
        <ModelMark model={model} />
        <strong>{chatModels[model].name}</strong>
        {!single && (
          <button
            className="chat-expand-toggle"
            aria-label={`${expanded ? '縮回' : '放大'} ${chatModels[model].name}`}
            aria-expanded={expanded}
            onClick={() => {
              if (!expanded) {
                splitPosition.current = feed.current?.scrollTop ?? 0;
                splitFollow.current = follow.current;
              }
              onToggle();
            }}
          >
            {expanded ? <ArrowLeft size={18} /> : <Maximize2 size={18} />}
            {expanded ? '返回分割' : '放大閱讀'}
          </button>
        )}
        {single && onStop && (
          <button className="chat-action" onClick={onStop}>
            <Square size={15} />
            停止
          </button>
        )}
      </div>
      <div
        className="chat-transcript"
        ref={feed}
        tabIndex={0}
        aria-label={`${chatModels[model].name} 的對話`}
        onScroll={() => {
          const node = feed.current;
          if (!node || hidden || adjusting.current) return;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
      >
        {children}
      </div>
      {!expanded && footer}
      {expanded && !single && onStop && (
        <button className="chat-model-stop chat-action" onClick={onStop}>
          <Square size={15} />
          停止此 AI
        </button>
      )}
    </section>
  );
}

interface Props {
  apiKey: string;
  showMoney: boolean;
  systemPrompt: string;
  chatMode: ChatMode;
  sessionId: string;
  onNavigate: (id: string) => void;
  onSettings: () => void;
  notify: (message: string) => void;
}
export function ChatWorkspace({
  apiKey,
  showMoney,
  systemPrompt,
  chatMode,
  sessionId,
  onNavigate,
  onSettings,
  notify,
}: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(rememberedModels);
  const [expanded, setExpanded] = useState<ChatModelId | null>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [search, setSearch] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [viewVersions, setViewVersions] = useState<Record<string, string>>({});
  const [fork, setFork] = useState<{
    seed: ChatHistoryMessage[];
    source: NonNullable<ChatSession['fork']>;
    draft: string;
    attachments: ChatAttachment[];
  } | null>(null);
  const initialized = useRef('');
  const refreshSequence = useRef(0);
  const route = useRef(sessionId);
  route.current = sessionId;
  const dialog = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const current = sessions.find((item) => item.id === sessionId);
  const uploadsDisabled = (current?.models ?? selected).includes('deepseekPro');
  const active = current ? isChatSessionActive(current) : false;
  useEffect(() => setSidebar(false), [sessionId]);
  useLayoutEffect(() => {
    if (!sidebar) return;
    const topbar = document.querySelector('.chat-shell > .topbar');
    if (!topbar) return;
    const updateTop = () => {
      document.documentElement.style.setProperty(
        '--chat-sidebar-top',
        `${topbar.getBoundingClientRect().bottom}px`,
      );
    };
    updateTop();
    const observer = new ResizeObserver(updateTop);
    observer.observe(topbar);
    window.addEventListener('resize', updateTop);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateTop);
    };
  }, [sidebar]);
  const refresh = useCallback(async () => {
    const ticket = ++refreshSequence.current;
    try {
      const values = await listChatSessions();
      if (ticket === refreshSequence.current) {
        setSessions(values);
        setStorageFailed(false);
      }
    } catch {
      if (ticket === refreshSequence.current) setStorageFailed(true);
    } finally {
      if (ticket === refreshSequence.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener('studio-change', refresh);
    const failed = () =>
      notify('回答無法保存，請檢查裝置空間。已停止接收；重新開啟可恢復先前保存的內容。');
    window.addEventListener('chat-storage-error', failed);
    return () => {
      refreshSequence.current++;
      route.current = '';
      window.removeEventListener('studio-change', refresh);
      window.removeEventListener('chat-storage-error', failed);
    };
  }, [refresh, notify]);
  useEffect(() => {
    initialized.current = '';
    setExpanded(null);
    setViewVersions({});
    if (sessionId)
      void recoverChatSession(sessionId).catch(() => notify('無法確認對話狀態，請稍後再試。'));
  }, [sessionId, notify]);
  useEffect(() => {
    if (current && initialized.current !== current.id) {
      initialized.current = current.id;
      setText(current.draft);
      setAttachments(current.draftAttachments);
      setSearch(current.search);
    }
  }, [current]);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node) return;
    const resize = () => {
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, 164)}px`;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) {
        width = node.clientWidth;
        resize();
      }
    });
    let width = node.clientWidth;
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, loaded, current?.id]);
  useEffect(() => {
    if (!fork) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) {
        event.preventDefault();
        setFork(null);
      }
      if (event.key === 'Tab') {
        const controls = [
          ...(node?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, [tabindex="0"]',
          ) ?? []),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [fork, creating]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        '--chat-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        '--chat-viewport-top',
        `${viewport?.offsetTop ?? 0}px`,
      );
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
    };
  }, []);
  const persistDraft = (
    patch: Partial<Pick<ChatSession, 'draft' | 'draftAttachments' | 'search'>>,
  ) => {
    if (sessionId)
      void updateChatSession(sessionId, (value) => Object.assign(value, patch)).catch(() =>
        notify('草稿無法保存，請檢查裝置空間。'),
      );
  };
  const createSession = async (
    draft: string,
    draftAttachments: ChatAttachment[],
    navigate = true,
  ) => {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: fork ? '延續的新對話' : '新對話',
      models: [...selected],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seed: fork?.seed ?? [],
      turns: [],
      draft,
      draftAttachments,
      search: false,
      ...(fork ? { fork: fork.source } : {}),
    };
    await saveChatSession(session);
    try {
      localStorage.setItem(CHAT_SELECTION_KEY, JSON.stringify(selected));
    } catch {
      notify('模型偏好無法保存。');
    }
    if (navigate) {
      onNavigate(session.id);
      await refresh();
    }
    return session;
  };
  const create = async () => {
    if (!selected.length || creating) return;
    setCreating(true);
    try {
      await createSession(fork?.draft ?? '', fork?.attachments ?? []);
      setFork(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : '無法建立對話。');
    } finally {
      setCreating(false);
    }
  };
  const beginFork = (model: ChatModelId, turn: ChatTurn, edit = false) => {
    if (!current) return;
    const index = current.turns.findIndex((item) => item.id === turn.id);
    const source = structuredClone(
      edit ? { ...current, turns: current.turns.slice(0, index) } : current,
    );
    if (!edit && viewVersions[`${turn.id}:${model}`])
      source.turns[index].selectedAnswers[model] = viewVersions[`${turn.id}:${model}`];
    setFork({
      seed: chatHistory(source, model, edit ? undefined : turn.id),
      source: { sessionId: current.id, model, turnId: turn.id },
      draft: edit ? turn.text : '',
      attachments: edit ? turn.attachments : [],
    });
    setSelected(upgradedSelection(current.models));
  };
  const submit = async () => {
    if (submitting || creating || active || preparing || (!selected.length && !current)) return;
    if (!apiKey) {
      notify('請先設定 Runware 服務，再送出問題。');
      onSettings();
      return;
    }
    setSubmitting(true);
    let createdSession: ChatSession | undefined;
    try {
      const target = current ?? (createdSession = await createSession(text, attachments, false));
      await sendChat({
        sessionId: target.id,
        key: apiKey,
        text,
        attachments,
        search,
        systemPrompt,
        chatMode,
      });
      setExpanded(null);
      if (createdSession) {
        await refresh();
        onNavigate(target.id);
      }
      if (route.current === target.id || !current) {
        setText('');
        setAttachments([]);
      }
    } catch (error) {
      if (createdSession) {
        await refresh();
        onNavigate(createdSession.id);
      }
      notify(error instanceof Error ? error.message : '無法送出問題。');
    } finally {
      setSubmitting(false);
    }
  };
  const retry = async (model: ChatModelId) => {
    if (!current || active || submitting) return;
    setSubmitting(true);
    try {
      await sendChat({
        sessionId: current.id,
        key: apiKey,
        text: '',
        attachments: [],
        search,
        retryModel: model,
        systemPrompt,
        chatMode,
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : '無法重新回答。');
    } finally {
      setSubmitting(false);
    }
  };
  const addFiles = async (files: File[]) => {
    if (uploadsDisabled) {
      notify('DeepSeek Pro 不支援上傳檔案，請先取消選取它。');
      return;
    }
    if (preparing) return;
    if (attachments.length + files.length > 4) {
      notify('每次最多加入 4 個附件。');
      return;
    }
    const target = current?.id ?? '';
    setPreparing(true);
    try {
      for (const file of files) {
        const item = await prepareChatAttachment(file, target || undefined);
        if (route.current === target) setAttachments((previous) => [...previous, item]);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '附件無法讀取。');
    } finally {
      setPreparing(false);
    }
  };
  const selection = (
    <div className="chat-model-picker">
      {selectableChatModelIds.map((model) => (
        <button
          key={model}
          className={`chat-model-option ${selected.includes(model) ? 'selected' : ''}`}
          aria-pressed={selected.includes(model)}
          disabled={!selected.includes(model) && selected.length >= maxSelectedChatModels}
          onClick={() => {
            if (
              !selected.includes(model) &&
              model === 'deepseekPro' &&
              (attachments.length ||
                fork?.attachments.length ||
                fork?.seed.some((message) => message.attachments?.length))
            ) {
              notify('DeepSeek Pro 不支援上傳檔案；請先移除附件，含附件的對話請選其他 AI。');
              return;
            }
            if (!selected.includes(model) && search && !chatModels[model].search) {
              notify(`${chatModels[model].name}不支援搜尋網路，請先關閉搜尋網路再選取。`);
              return;
            }
            setSelected((previous) =>
              previous.includes(model)
                ? previous.filter((id) => id !== model)
                : [...previous, model],
            );
          }}
        >
          <ModelMark model={model} />
          <span>
            <strong>{chatModels[model].name}</strong>
            <small>
              {model === 'gpt6Sol' ? (
                <>
                  深入分析 · <em className="chat-search-description">可查詢網路資料</em>
                </>
              ) : model === 'deepseekPro' ? (
                <>
                  深入推理 · <em className="chat-upload-description">不支援上傳檔案</em>
                </>
              ) : (
                chatModels[model].description
              )}
            </small>
            {showMoney && chatTokenPrices[model] && (
              <small className="chat-model-price">
                輸入 ${chatTokenPrices[model].input} · 輸出 ${chatTokenPrices[model].output}
                <span className="chat-price-denomination"> USD／百萬 tokens</span>
              </small>
            )}
          </span>
          <span className="chat-selection-check">
            {selected.includes(model) && <Check size={15} />}
          </span>
        </button>
      ))}
    </div>
  );
  const fullModel = current?.models.length === 1 ? current.models[0] : expanded;
  const lastTurn = current?.turns.at(-1);
  const renderTurn = (turn: ChatTurn, model: ChatModelId, index: number, detailed: boolean) => {
    const versions = turn.answers[model] ?? [];
    const answer =
      versions.find((item) => item.id === viewVersions[`${turn.id}:${model}`]) ??
      selectedChatAnswer(turn, model);
    const version = versions.findIndex((item) => item.id === answer?.id);
    const chooseVersion = (id: string) => {
      if (index < current!.turns.length - 1)
        setViewVersions((previous) => ({ ...previous, [`${turn.id}:${model}`]: id }));
      else
        void updateChatSession(current!.id, (value) => {
          if (isChatSessionActive(value) || value.turns.at(-1)?.id !== turn.id)
            throw new Error('對話已更新，請重新開啟。');
          value.turns[index].selectedAnswers[model] = id;
        }).catch(() => notify('無法切換回答。'));
    };
    return (
      <div className="chat-turn" key={turn.id}>
        <div className="chat-user-message">
          {detailed && <small>你</small>}
          <p>{turn.text || '請查看附件'}</p>
          <AttachmentList items={turn.attachments} />
          <button
            hidden={!detailed}
            className="chat-action"
            disabled={active || preparing}
            onClick={() => beginFork(model, turn, true)}
          >
            <Pencil size={14} />
            修改並建立分支
          </button>
        </div>
        <div className="chat-assistant-message">
          {detailed && <small>{chatModels[model].name}</small>}
          {answer?.text && <ChatMarkdown text={answer.text} />}
          {answer && ['queued', 'streaming'].includes(answer.status) && (
            <p className="chat-progress" role="status">
              <LoaderCircle size={16} className="spin" />
              {statusText[answer.status]}
            </p>
          )}
          {answer && (
            <>
              {answer.error && (
                <p className="chat-inline-error" role="status">
                  {answer.error}
                </p>
              )}
              {detailed && <Sources items={answer.sources} />}
              {detailed &&
                turn.search &&
                answer.status === 'complete' &&
                !answer.sources.length && (
                  <small className="chat-muted">本次允許搜尋，服務商未回傳可顯示的來源。</small>
                )}
              <div className="chat-answer-actions" hidden={!detailed}>
                <CopyButton text={answer.text} />
                <button
                  className="chat-action"
                  disabled={active || preparing || !answer.text}
                  onClick={() => beginFork(model, turn)}
                >
                  <GitFork size={14} />
                  從這裡開新對話
                </button>
                {index === current!.turns.length - 1 && (
                  <button
                    className="chat-action"
                    disabled={active || submitting}
                    onClick={() => void retry(model)}
                  >
                    <RotateCcw size={14} />
                    重新回答
                  </button>
                )}
                {versions.length > 1 && (
                  <span className="chat-versions">
                    <button
                      aria-label="上一個回答版本"
                      disabled={active || version <= 0}
                      onClick={() => chooseVersion(versions[version - 1].id)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    {version + 1} / {versions.length}
                    <button
                      aria-label="下一個回答版本"
                      disabled={active || version >= versions.length - 1}
                      onClick={() => chooseVersion(versions[version + 1].id)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </span>
                )}
                {showMoney && !['queued', 'streaming'].includes(answer.status) && (
                  <small className="chat-cost chat-answer-cost">
                    本次回答花費 {answer.cost !== undefined ? money(answer.cost) : '服務商未提供'}
                  </small>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <section className="chat-workspace" aria-label="聊天問答">
      {sidebar && (
        <button
          className="chat-sidebar-backdrop"
          aria-label="收起歷史對話"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`chat-sidebar ${sidebar ? 'open' : ''}`}
        aria-label="歷史對話"
        aria-hidden={!sidebar}
        inert={!sidebar}
      >
        <div className="chat-sidebar-heading">
          <strong>我的對話</strong>
          <button
            className="icon-button"
            aria-label="收起歷史對話"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="secondary full"
          disabled={preparing}
          onClick={() => {
            setFork(null);
            onNavigate('');
            setSidebar(false);
          }}
        >
          <Plus size={17} />
          新對話
        </button>
        <label className="chat-history-search">
          <Search size={16} />
          <input
            aria-label="搜尋歷史對話"
            placeholder="搜尋對話"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="chat-history-list">
          {sessions
            .filter((session) =>
              `${session.title} ${session.seed.map((item) => item.content).join(' ')} ${session.turns
                .map(
                  (turn) =>
                    `${turn.text} ${Object.values(turn.answers)
                      .flat()
                      .map((answer) => answer?.text)
                      .join(' ')}`,
                )
                .join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((session) => (
              <div
                className={`chat-history-item ${session.id === sessionId ? 'selected' : ''}`}
                key={session.id}
              >
                <button
                  disabled={preparing}
                  onClick={() => {
                    onNavigate(session.id);
                    setSidebar(false);
                  }}
                >
                  <span>{session.title}</span>
                  <small>
                    {session.models.map((model) => chatModels[model].family).join(' · ')}
                    {isChatSessionActive(session) ? ' · 回答中' : ''}
                  </small>
                </button>
                <button
                  className="chat-history-delete"
                  aria-label={`刪除 ${session.title}`}
                  disabled={isChatSessionActive(session) || preparing}
                  onClick={() => {
                    if (
                      confirm(
                        `刪除「${session.title}」與其中的對話？已建立的其他分支會保留。此操作無法復原。`,
                      )
                    )
                      void removeChatSession(session.id)
                        .then(() => {
                          if (session.id === sessionId) onNavigate('');
                        })
                        .catch(() => notify('刪除失敗，請稍後再試。'));
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
        </div>
      </aside>
      <div className="chat-main">
        <div className="chat-toolbar">
          <button
            className="icon-button"
            aria-label="展開歷史對話"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={20} />
          </button>
          <strong>{current?.title ?? '聊天問答'}</strong>
          {current && (
            <button
              className="icon-button"
              aria-label="重新命名對話"
              onClick={() => {
                const title = prompt('對話名稱', current.title);
                if (title?.trim())
                  void updateChatSession(current.id, (value) => {
                    value.title = title.trim().slice(0, 100);
                  }).catch(() => notify('無法保存名稱。'));
              }}
            >
              <Pencil size={16} />
            </button>
          )}
          <button
            className="chat-action"
            disabled={preparing}
            onClick={() => {
              setFork(null);
              onNavigate('');
            }}
          >
            <Plus size={17} />
            新對話
          </button>
        </div>
        {current?.models.some(
          (model) => !(selectableChatModelIds as readonly string[]).includes(model),
        ) && (
          <p className="chat-legacy-note">
            這是使用舊模型建立的對話。可從回答建立分支，或開新對話，選用目前的模型。
          </p>
        )}
        {storageFailed ? (
          <div className="chat-intro">
            <p role="alert">無法讀取本機對話，請確認儲存空間。</p>
            <button className="secondary" onClick={() => void refresh()}>
              重試
            </button>
          </div>
        ) : !loaded ? (
          <div className="chat-intro">
            <LoaderCircle className="spin" />
          </div>
        ) : !current ? (
          <div className="chat-intro">
            <div className="chat-welcome">
              <span className="chat-welcome-icon" aria-hidden="true">
                <MessageCircle size={28} />
              </span>
              <div>
                <h1>一個問題，多種想法</h1>
                <p>選擇 1–3 個 AI，輸入問題就能開始聊。</p>
              </div>
            </div>
            <div className="chat-picker-heading">
              <strong>{sessionId ? '找不到這份對話' : '選擇 AI'}</strong>
              <span>已選 {selected.length}／3 個</span>
            </div>
            {selection}
          </div>
        ) : (
          <div
            className={`chat-panels ${fullModel ? 'has-expanded' : ''}`}
            style={{
              gridTemplateRows: current.models
                .map((model) =>
                  fullModel && fullModel !== model ? 'minmax(0, 0fr)' : 'minmax(0, 1fr)',
                )
                .join(' '),
            }}
          >
            {current.models.map((model) => {
              const detailed = fullModel === model;
              const answer = lastTurn && selectedChatAnswer(lastTurn, model);
              return (
                <ChatPanel
                  key={`${current.id}:${model}`}
                  model={model}
                  expanded={detailed}
                  hidden={!!fullModel && !detailed}
                  single={current.models.length === 1}
                  revision={current}
                  onToggle={() => setExpanded(detailed ? null : model)}
                  onStop={
                    answer && ['queued', 'streaming'].includes(answer.status)
                      ? () => stopChat(current.id, model)
                      : undefined
                  }
                  footer={
                    showMoney && answer && !['queued', 'streaming'].includes(answer.status) ? (
                      <small className="chat-preview-footer">
                        本次 {answer.cost !== undefined ? money(answer.cost) : '費用未提供'}
                      </small>
                    ) : null
                  }
                >
                  {current.seed.length > 0 && (
                    <>
                      <div className="chat-seed-label">從原對話接續的歷史</div>
                      {current.seed.map((item, index) => (
                        <div
                          className={
                            item.role === 'user' ? 'chat-user-message' : 'chat-assistant-message'
                          }
                          key={index}
                        >
                          {detailed && <small>{item.role === 'user' ? '你' : '原對話 · AI'}</small>}
                          <ChatMarkdown text={item.content} />
                          <AttachmentList items={item.attachments ?? []} />
                          {detailed && <Sources items={item.sources ?? []} />}
                        </div>
                      ))}
                      <div className="chat-seed-label">新的對話從這裡開始</div>
                    </>
                  )}
                  {current.turns.map((turn, index) => renderTurn(turn, model, index, detailed))}
                </ChatPanel>
              );
            })}
          </div>
        )}
        {(current || (loaded && !storageFailed)) && (
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <AttachmentList
              items={attachments}
              remove={
                preparing || submitting
                  ? undefined
                  : (id) => {
                      const next = attachments.filter((item) => item.id !== id);
                      setAttachments(next);
                      persistDraft({ draftAttachments: next });
                    }
              }
            />
            <textarea
              ref={textRef}
              aria-label="輸入聊天訊息"
              placeholder="輸入你的問題…"
              value={text}
              maxLength={24000}
              rows={2}
              disabled={submitting}
              onChange={(event) => {
                setText(event.target.value);
                persistDraft({ draft: event.target.value });
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229 &&
                  window.matchMedia('(pointer: fine)').matches
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="chat-composer-tools">
              <label
                className={`chat-action ${preparing || submitting || uploadsDisabled ? 'disabled' : ''}`}
                title={uploadsDisabled ? 'DeepSeek Pro 不支援上傳檔案' : undefined}
              >
                <Paperclip size={18} />
                {preparing ? '處理檔案…' : '上傳檔案'}
                <input
                  type="file"
                  aria-label="加入聊天附件"
                  multiple
                  accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt"
                  disabled={preparing || submitting || uploadsDisabled}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void addFiles(files);
                  }}
                />
              </label>
              <button
                type="button"
                className={`chat-action chat-search-toggle ${search ? 'selected' : ''}`}
                aria-pressed={search}
                onClick={() => {
                  if (!search) {
                    const unsupported = (current?.models ?? selected).filter(
                      (model) => !chatModels[model].search,
                    );
                    if (unsupported.length) {
                      notify(
                        `${unsupported.map((model) => chatModels[model].family).join('、')}不支援搜尋；請改選支援的模型。`,
                      );
                      return;
                    }
                  }
                  setSearch(!search);
                  persistDraft({ search: !search });
                }}
              >
                <Globe size={17} />
                搜尋網路
              </button>
              <span className="chat-composer-spacer" />
              {active ? (
                <button
                  type="button"
                  className="chat-stop"
                  onClick={() => current && stopChat(current.id)}
                >
                  <Square size={14} />
                  全部停止
                </button>
              ) : (
                <button
                  className="chat-send"
                  type="submit"
                  aria-label="送出給所有 AI"
                  disabled={
                    submitting ||
                    creating ||
                    preparing ||
                    (!current && !selected.length) ||
                    (!text.trim() && !attachments.length)
                  }
                >
                  傳送
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
            <small className="chat-composer-note">
              {active
                ? '等全部回答完成或停止後即可送出下一題。'
                : `傳送給 ${current?.models.length ?? selected.length} 個 AI`}
            </small>
          </form>
        )}
      </div>
      {fork && (
        <div className="chat-dialog-backdrop">
          <section
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-fork-title"
            className="chat-fork-dialog"
          >
            <button
              className="icon-button chat-dialog-close"
              aria-label="取消建立分支"
              onClick={() => setFork(null)}
            >
              <X size={20} />
            </button>
            <h2 id="chat-fork-title">從這裡開新對話</h2>
            <p>
              帶入你與 {chatModels[fork.source.model].name} 的問答，重新選擇 1–3 個
              AI。原對話會保留。
            </p>
            {selection}
            <button
              className="primary full"
              disabled={!selected.length || creating}
              onClick={() => void create()}
            >
              建立新對話
            </button>
            <small>只載入歷史；按下送出才會呼叫 AI。</small>
          </section>
        </div>
      )}
    </section>
  );
}
