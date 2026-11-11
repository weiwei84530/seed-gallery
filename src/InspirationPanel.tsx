import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lightbulb, LoaderCircle } from 'lucide-react';
import {
  fetchInspiration,
  inspirationContext,
  promptRecords,
  type InspirationIdea,
} from './inspiration';
import type { Draft, Job } from './types';

const pendingWorks = new Set<string>();

export function InspirationPanel({
  workId,
  draft,
  jobs,
  apiKey,
  showMoney,
  disabled,
  onApply,
  onSettled,
  children,
}: {
  workId: string;
  draft: Draft;
  jobs: Job[];
  apiKey: string;
  showMoney: boolean;
  disabled: boolean;
  onApply: (prompt: string) => void;
  onSettled: () => void;
  children: (inspirationButton: ReactNode) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<{ source: string; ideas: InspirationIdea[] }>();
  const [lastCost, setLastCost] = useState<number>();
  const previousIdeas = useRef<InspirationIdea[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const focusEditor = useRef(false);
  const live = useRef(true);
  const context = inspirationContext(draft);
  const latest = useRef({ context, apiKey });
  latest.current = { context, apiKey };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = suggestions?.source === context ? suggestions : undefined;
  useEffect(() => {
    if (current) container.current?.querySelector<HTMLButtonElement>('.inspiration-idea')?.focus();
    else if (focusEditor.current) {
      container.current?.querySelector('textarea')?.focus();
      focusEditor.current = false;
    }
  }, [current]);

  const generate = async () => {
    if (disabled || busy || current) return;
    if (pendingWorks.has(workId)) {
      setError('這份作品正在取得靈感，請稍候再試。');
      return;
    }
    if (!apiKey) {
      setError('請先到右上角的設定輸入 API Key，再取得靈感。');
      return;
    }
    if (!navigator.onLine) {
      setError('目前離線，請連上網路後再取得靈感。');
      return;
    }
    pendingWorks.add(workId);
    setBusy(true);
    setError('');
    setLastCost(undefined);
    try {
      const result = await fetchInspiration(
        apiKey,
        structuredClone(draft),
        promptRecords(jobs, draft.kind ?? 'image'),
        previousIdeas.current,
      );
      if (!live.current || latest.current.apiKey !== apiKey) return;
      setLastCost(result.cost);
      previousIdeas.current = result.ideas;
      if (latest.current.context !== context) {
        setError('描述、照片或設定已改變，這批靈感未套用。請依目前內容重新取得靈感。');
        return;
      }
      setSuggestions({ source: context, ideas: result.ideas });
    } catch (err) {
      if (live.current)
        setError(err instanceof Error ? err.message : '暫時無法取得靈感，請稍後再試。');
    } finally {
      pendingWorks.delete(workId);
      if (live.current) setBusy(false);
      onSettled();
    }
  };

  const returnToEditor = (prompt?: string) => {
    focusEditor.current = true;
    if (prompt !== undefined) onApply(prompt);
    setSuggestions(undefined);
  };

  return (
    <div className="inspiration" ref={container}>
      <div className="prompt-heading">
        {current ? (
          <span className="section-label">
            <span className="step">01</span>描述你的想法
          </span>
        ) : (
          <label className="section-label" htmlFor="prompt">
            <span className="step">01</span>描述你的想法
          </label>
        )}
      </div>
      {current ? (
        <div className="inspiration-results" aria-label="靈感選項">
          <div className="inspiration-grid">
            {current.ideas.map((idea, index) => (
              <button
                key={`${index}:${idea.title}`}
                type="button"
                className="inspiration-idea"
                disabled={disabled}
                onClick={() => returnToEditor(idea.prompt)}
              >
                <span className="idea-heading">
                  <span className="idea-number">{String(index + 1).padStart(2, '0')}</span>
                  <strong>{idea.title}</strong>
                </span>
                <span className="idea-prompt">{idea.prompt}</span>
              </button>
            ))}
            <button type="button" className="inspiration-dismiss" onClick={() => returnToEditor()}>
              <span className="idea-number">05</span>回到原本的編輯
            </button>
          </div>
        </div>
      ) : (
        children(
          <button
            type="button"
            className="inspiration-trigger"
            disabled={busy || disabled}
            onClick={() => void generate()}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Lightbulb size={15} />}
            <span role={busy ? 'status' : undefined}>{busy ? '正在想點子…' : '給我一點靈感'}</span>
          </button>,
        )
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {showMoney && current && lastCost !== undefined && (
        <p className="inspiration-cost">本次靈感花費 US$ {lastCost.toFixed(6)}</p>
      )}
    </div>
  );
}
