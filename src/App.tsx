import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listChatSessions } from './chat-db';
import { recoverChatSessions } from './chat-engine';
import { isChatSessionActive } from './chat-types';
const ChatWorkspace = lazy(() =>
  import('./ChatWorkspace').then((module) => ({ default: module.ChatWorkspace })),
);
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  FolderHeart,
  ImagePlus,
  Images,
  Leaf,
  LoaderCircle,
  Minus,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Film,
  Play,
  Smartphone,
  Maximize2,
} from 'lucide-react';
import {
  clearWorks,
  getMedia,
  isDatabaseUpgradeBlocked,
  removeWork,
  saveWork,
  snapshot,
  storageUsage,
} from './db';
import { exportBackup, importBackup } from './backup';
import { HomeIllustration } from './HomeIllustration';
import { HomeTour } from './HomeTour';
import { WelcomeIllustration } from './WelcomeIllustration';
import { usePwa } from './pwa';
import { ModelPicker, ProviderLogo } from './ModelPicker';
import { InspirationPanel } from './InspirationPanel';
import { hasCreditFailure, queueGeneration, resumeJobs, runJob } from './engine';
import {
  currentDraft,
  dimensions,
  fixedVideoAudio,
  models,
  modelsFor,
  promptLimit,
  supportsSquareVideo,
  videoAudioFor,
  videoResolutionFor,
  videoResolutionOptions,
} from './models';
import { rememberDraft, rememberedDraft, clearDraftDefaults } from './draft-defaults';
import { download, importPhoto } from './media';
import {
  readKey,
  readPreferences,
  resetPreferences,
  saveKey,
  savePreferences,
  effectiveChatMode,
  setChatModeControls,
} from './preferences';
import { ApiError, fetchBalance, isCredentialError, keyTag, validateKey } from './runware';
import { estimateModelCost, type ModelEstimate } from './pricing';
import { visibleWorks, workPreview } from './work-list';
import {
  isActive,
  isVideo,
  type Balance,
  type Draft,
  type Job,
  type Preferences,
  type Work,
  type WorkKind,
  type ModelId,
} from './types';

const REPO = 'https://github.com/weiwei84530/seed-gallery';
const STUDIO = 'https://weiweistudio.com';
const HOME_TOUR_KEY = 'img-generator.home-tour-seen';
const STORAGE_NOTE = '圖像只暫存在瀏覽器；喜歡的作品請記得下載到裝置，避免遺失。';
const formatBytes = (bytes: number) =>
  bytes === 0
    ? '0 KB'
    : bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const money = (value: number) => `US$ ${value.toFixed(4).replace(/0{1,2}$/, '')}`;
const date = (value: number) =>
  new Intl.DateTimeFormat('zh-TW', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
type Notify = (message: string) => void;
interface ToastMessage {
  id: number;
  message: string;
}

function Toast({ notice }: { notice: ToastMessage }) {
  return (
    <div key={notice.id} className="toast" role="status">
      <span>{notice.message}</span>
    </div>
  );
}
type Screen = 'home' | 'work' | 'library' | 'key' | 'chat';
type WorkTab = 'edit' | 'results';
interface NavigationState {
  studio: true;
  screen: Screen;
  workId?: string;
  sessionId?: string;
  workTab?: WorkTab;
  overlay?: 'settings' | 'viewer' | 'fullscreen' | 'key';
  jobId?: string;
  referenceId?: string;
}

const isSystemTitle = (title: string) => ['還沒命名的作品', '從照片開始的新作品'].includes(title);

function AnimatedNumber({ value }: { value: number }) {
  const element = useRef<HTMLElement>(null);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      element.current?.animate(
        [
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(-3px) scale(1.12)' },
          { transform: 'translateY(0) scale(1)' },
        ],
        { duration: 280, easing: 'ease-out' },
      );
    previous.current = value;
  }, [value]);
  return (
    <strong className="animated-number" ref={element}>
      {value}
    </strong>
  );
}

function LocalImage({
  id,
  alt,
  className,
  controls = false,
  onDimensions,
}: {
  id: string;
  alt: string;
  className?: string;
  controls?: boolean;
  onDimensions?: (size: { width: number; height: number }) => void;
}) {
  const [url, setUrl] = useState('');
  const [video, setVideo] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => {
    setPlaybackError(false);
    let alive = true;
    let objectUrl = '';
    void getMedia(id)
      .then((media) => {
        if (alive && media) {
          setVideo(media.blob.type === 'video/mp4');
          objectUrl = URL.createObjectURL(media.blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return url ? (
    video ? (
      <>
        <video
          src={url}
          aria-label={alt}
          className={className}
          controls={controls}
          muted={!controls}
          playsInline
          preload="metadata"
          onError={() => setPlaybackError(true)}
        />
        {controls && playbackError && (
          <p className="hint" role="status">
            這個瀏覽器無法播放影片，請使用下方「下載影片」後開啟。
          </p>
        )}
      </>
    ) : (
      <img
        src={url}
        alt={alt}
        className={className}
        onLoad={(event) =>
          onDimensions?.({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
      />
    )
  ) : (
    <div className="image-placeholder">
      <Images aria-hidden="true" />
      <span>載入作品</span>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
  wide = false,
  notice,
  fullscreen = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  notice?: ToastMessage | null;
  fullscreen?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = old;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={fullscreen ? 'modal viewer fullscreen-viewer' : wide ? 'modal viewer' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label={fullscreen ? '離開滿版檢視' : '關閉'}
        >
          <X />
        </button>
      </div>
      {notice && <Toast notice={notice} />}
      {children}
    </dialog>
  );
}

function KeyForm({
  onSuccess,
  replacing = false,
  initialKey = '',
}: {
  onSuccess: (key: string) => void;
  replacing?: boolean;
  initialKey?: string;
}) {
  const [input, setInput] = useState(initialKey);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
          const key = input.trim();
          if (!key) throw new Error('請輸入 Runware API Key。');
          await validateKey(key);
          if (!mounted.current) return;
          saveKey(key);
          onSuccess(key);
          setInput('');
        } catch (err) {
          setError(err instanceof Error ? err.message : '無法連線，請稍後再試。');
        } finally {
          submitting.current = false;
          setBusy(false);
        }
      }}
    >
      <label htmlFor={replacing ? 'replacement-key' : 'api-key'}>Runware API Key</label>
      <div className="key-input">
        <input
          id={replacing ? 'replacement-key' : 'api-key'}
          type={visible ? 'text' : 'password'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="貼上你的 API Key"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={busy}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={visible ? '隱藏 Key' : '顯示 Key'}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={20} /> : <Eye size={20} />}
        </button>
      </div>
      <p className="hint">驗證成功後會記住這台裝置。請在你信任的瀏覽器使用。</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <a className="small-link" href="https://runware.ai" target="_blank" rel="noreferrer">
        前往 Runware 取得 API Key <ExternalLink size={13} />
      </a>
      <button className="primary full" disabled={busy || !input.trim()}>
        {busy ? <LoaderCircle className="spin" /> : <ArrowRight />}
        {busy ? '正在確認服務…' : replacing ? '驗證並更換 Key' : '連線，開始創作'}
      </button>
    </form>
  );
}

function LinkedKeySetup({
  linkedKey,
  existingKey,
  onSuccess,
  onCancel,
}: {
  linkedKey: string;
  existingKey: string;
  onSuccess: (key: string) => void;
  onCancel: () => void;
}) {
  const [accepted, setAccepted] = useState(!existingKey || existingKey === linkedKey);
  const [failed, setFailed] = useState(false);
  const validation = useRef<Promise<void> | null>(null);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  useEffect(() => {
    if (!accepted) return;
    let live = true;
    // Reuse the request during StrictMode's effect replay.
    validation.current ??= validateKey(linkedKey);
    void validation.current.then(
      () => {
        if (!live) return;
        try {
          saveKey(linkedKey);
          success.current(linkedKey);
        } catch {
          setFailed(true);
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [accepted, linkedKey]);
  return (
    <section className="card setup-card">
      <h2>{accepted ? '設定服務' : '更換服務 Key？'}</h2>
      {!accepted ? (
        <>
          <p>這台裝置已設定另一組 API Key。要改用連結中的 Key 嗎？作品與其他設定會保留。</p>
          <button className="primary full" onClick={() => setAccepted(true)}>
            更換 Key
          </button>
          <button className="secondary full" onClick={onCancel}>
            保留原本的 Key
          </button>
        </>
      ) : failed ? (
        <>
          <p className="error" role="alert">
            無法完成設定。請確認網路與 Key 是否有效，並允許瀏覽器保存資料，再試一次。
          </p>
          <KeyForm initialKey={linkedKey} replacing={Boolean(existingKey)} onSuccess={onSuccess} />
          <button className="secondary full" onClick={onCancel}>
            取消設定
          </button>
        </>
      ) : (
        <p role="status">
          <LoaderCircle className="spin" /> 正在確認服務，成功後會自動記住這台裝置…
        </p>
      )}
    </section>
  );
}

function Privacy() {
  return (
    <div className="privacy">
      <ShieldCheck size={21} />
      <div>
        <strong>你的作品，留在你的裝置</strong>
        <p>
          本站不設後端，也不收集你的 Key、照片或描述。生成時，內容會由瀏覽器直接傳送至 Runware
          及必要的上游服務，由服務商處理與依其政策保存。
        </p>
        <a href={REPO} target="_blank" rel="noreferrer">
          查看公開原始碼 <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}

function Welcome({
  onSuccess,
  onSkip,
  returning = false,
  replacing = false,
}: {
  onSuccess: (key: string) => void;
  onSkip: () => void;
  returning?: boolean;
  replacing?: boolean;
}) {
  return (
    <div className="welcome">
      <div className="eyebrow">
        <span /> A LITTLE SPACE TO CREATE
      </div>
      <h1>
        一個想法，<em>畫出不同可能。</em>
      </h1>
      <p className="intro">寫下你想看的畫面，讓不同 AI 各畫一張。</p>
      <WelcomeIllustration />
      <section className="card setup-card">
        <div className="section-kicker">{returning ? '服務設定' : '只需設定一次'}</div>
        <h2>設定服務</h2>
        <KeyForm onSuccess={onSuccess} replacing={replacing} />
        {!returning && (
          <button type="button" className="secondary full guest-entry" onClick={onSkip}>
            稍後設定 API Key
          </button>
        )}
      </section>
      <Privacy />
    </div>
  );
}

function MoneyBadge({
  balance,
  loading,
  refresh,
}: {
  balance: Balance | null;
  loading: boolean;
  refresh: () => void;
}) {
  return (
    <button className="balance" onClick={refresh} disabled={loading} aria-label="重新查詢餘額">
      {loading ? '餘額查詢中…' : balance ? `餘額 ${money(balance.amount)}` : '餘額暫時無法讀取'}
      {balance?.freeBalance !== undefined && balance.freeBalance > 0 && (
        <span>另有贈額 {money(balance.freeBalance)}</span>
      )}
    </button>
  );
}

function Workspace({
  work,
  jobs,
  historyJobs,
  refreshBalance,
  apiKey,
  showMoney,
  initialTab,
  notify,
  openImage,
  openReference,
}: {
  work: Work;
  jobs: Job[];
  historyJobs: Job[];
  refreshBalance: () => void;
  apiKey: string;
  showMoney: boolean;
  initialTab: WorkTab;
  notify: Notify;
  openImage: (job: Job) => void;
  openReference: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => currentDraft(work.draft));
  const latestDraft = useRef(draft);
  const [tab, setTab] = useState<WorkTab>(initialTab);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const submitLock = useRef(false);
  const latestSave = useRef<Promise<void>>(Promise.resolve());
  const [saveError, setSaveError] = useState(false);
  const [estimates, setEstimates] = useState<Partial<Record<ModelId, ModelEstimate>>>({});
  const active = jobs.some(isActive);
  const completedCount = jobs.filter((job) => job.status === 'succeeded').length;
  const total = draft.models.length * draft.count;
  const video = isVideo(draft);
  const unit = video ? '支' : '張';
  const mediaName = video ? '影片' : '圖片';
  const availableModels = modelsFor(video ? 'video' : 'image');
  const maxRefs = video ? 1 : draft.models.includes('grok') ? 3 : 4;
  const advancedModels = draft.models.filter(
    (model) =>
      video ||
      ['banana', 'gpt', 'gptFlare', 'gptSunburst', 'seedream', 'grok', 'muse'].includes(model),
  );
  useEffect(() => {
    let live = true;
    setEstimates({});
    for (const model of modelsFor(isVideo(draft) ? 'video' : 'image'))
      void estimateModelCost(model, draft).then((estimate) => {
        if (live) setEstimates((values) => ({ ...values, [model]: estimate }));
      });
    return () => {
      live = false;
    };
  }, [draft]);
  const selectedEstimates = draft.models.map((model) => estimates[model]);
  const priceLoading = selectedEstimates.some((estimate) => !estimate);
  const unknownPrices = draft.models.filter((model) => estimates[model]?.amount === null);
  const estimatedCost =
    selectedEstimates.reduce((sum, estimate) => sum + (estimate?.amount ?? 0), 0) * draft.count;
  const update = (patch: Partial<Draft>) => {
    const next = { ...latestDraft.current, ...patch };
    if (
      isVideo(next) &&
      next.ratio === 'square' &&
      !next.refs.length &&
      next.models.some((model) => !supportsSquareVideo(model))
    ) {
      next.ratio = 'portrait';
      notify('所選模型不提供方形選項，已切換為手機直向。');
    }
    try {
      rememberDraft(next);
    } catch {
      notify('這次設定無法記住，請檢查瀏覽器儲存空間。');
    }
    latestDraft.current = next;
    setDraft(next);
    const updated = {
      ...work,
      title: next.prompt.trim().slice(0, 36) || '還沒命名的作品',
      draft: next,
      updatedAt: Date.now(),
    };
    latestSave.current = saveWork(updated)
      .then(() => setSaveError(false))
      .catch(() => {
        setSaveError(true);
      });
  };
  const submit = async (target = draft) => {
    if (submitLock.current || active || uploading) return;
    if (!apiKey) {
      notify('請先到右上角的設定，輸入 API Key 後再生成。');
      return;
    }
    if (!navigator.onLine) {
      notify('目前離線，請連上網路後再開始生成。');
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await latestSave.current;
      await saveWork({
        ...work,
        draft,
        title: draft.prompt.trim().slice(0, 36) || work.title,
        updatedAt: Date.now(),
      });
      await queueGeneration(work.id, target, apiKey);
      setTab('results');
    } catch (err) {
      notify(err instanceof Error ? err.message : '尚未送出，請確認儲存空間後再試。');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  return (
    <>
      <div className="tabs" data-tab={tab} role="tablist" aria-label="工作區">
        <span className="tab-indicator" aria-hidden="true" />
        <button role="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>
          <Sparkles size={18} />
          編輯畫面
        </button>
        <button role="tab" aria-selected={tab === 'results'} onClick={() => setTab('results')}>
          <Images size={18} />
          本次作品{' '}
          <span className={`count${completedCount > 0 ? ' has-results' : ''}`}>
            {completedCount}
          </span>
          {active && <span className="working-dot" />}
        </button>
      </div>
      {saveError && (
        <p className="error" role="alert">
          草稿尚未保存。請確認裝置儲存空間，暫時不要離開。
        </p>
      )}
      {tab === 'edit' ? (
        <div className="editor" role="tabpanel" aria-label="編輯畫面">
          <section className="card prompt-card">
            <InspirationPanel
              workId={work.id}
              draft={draft}
              jobs={historyJobs}
              apiKey={apiKey}
              showMoney={showMoney}
              disabled={uploading || submitting}
              onApply={(prompt) => update({ prompt })}
              onSettled={refreshBalance}
            >
              {(inspirationButton) => (
                <>
                  <textarea
                    id="prompt"
                    value={draft.prompt}
                    maxLength={32000}
                    placeholder={
                      video
                        ? draft.refs.length
                          ? '例如：讓照片中的花朵隨風輕輕搖動，鏡頭緩慢靠近。'
                          : '例如：午後花園裡，一隻橘貓伸懶腰，陽光灑落，鏡頭緩慢靠近。'
                        : draft.refs.length
                          ? '想怎麼修改這張照片？例如：保留人物，把背景換成溫暖的花園。'
                          : '例如：一隻橘貓坐在窗邊，午後陽光灑在牠身上，溫柔的水彩風格…'
                    }
                    onChange={(e) => update({ prompt: e.target.value })}
                    rows={5}
                  />
                  <div className="prompt-footer">
                    <span className="prompt-hint">
                      <Leaf size={15} />
                      <span>
                        {video
                          ? draft.refs.length
                            ? '照片會作為影片的起始畫面'
                            : '描述動作、鏡頭與想要的氛圍'
                          : draft.refs.length
                            ? '這次會以你上傳的照片進行修改'
                            : '像跟朋友說話一樣，自然描述就好'}
                      </span>
                    </span>
                    {inspirationButton}
                  </div>
                  {draft.prompt.length > promptLimit(draft) && (
                    <p className="error" role="alert">
                      目前模型最多接受 {promptLimit(draft).toLocaleString()} 字，請縮短描述。
                    </p>
                  )}
                </>
              )}
            </InspirationPanel>
            <div className="refs">
              {draft.refs.map((ref, index) => (
                <div className="ref-image" key={ref}>
                  <button
                    className="ref-preview"
                    aria-label={`放大參考照片 ${index + 1}`}
                    onClick={() => openReference(ref)}
                  >
                    <LocalImage id={ref} alt={`參考照片 ${index + 1}`} />
                  </button>
                  <button
                    aria-label={`移除參考照片 ${index + 1}`}
                    onClick={() => update({ refs: draft.refs.filter((r) => r !== ref) })}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {draft.refs.length < maxRefs && (
                <label className="upload-button">
                  <ImagePlus size={21} />
                  <span>
                    {uploading ? '讀取照片中…' : video ? '讓照片動起來' : '編輯照片'}
                    <small>選填 · 最多 {maxRefs} 張</small>
                  </span>
                  <input
                    type="file"
                    aria-label={video ? '讓照片動起來' : '編輯照片'}
                    accept="image/jpeg,image/png,image/webp"
                    multiple={!video}
                    disabled={uploading}
                    onChange={async (e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (files.length + draft.refs.length > maxRefs) {
                        notify(`最多可加入 ${maxRefs} 張參考照片。`);
                        return;
                      }
                      setUploading(true);
                      try {
                        const refs = [];
                        for (const file of files) refs.push(await importPhoto(file));
                        update({ refs: [...draft.refs, ...refs] });
                      } catch (err) {
                        notify(err instanceof Error ? err.message : '照片無法保存。');
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </section>
          <section className="card">
            <div className="section-row">
              <h2 className="section-label">
                <span className="step">02</span>選擇創作 AI
              </h2>
              <span className="subtle-pill">已選 {draft.models.length} 個</span>
            </div>
            <ModelPicker
              selected={draft.models}
              available={availableModels}
              onChange={(selected) => {
                if (selected.includes('grok') && draft.refs.length > 3) {
                  notify('Grok 最多使用 3 張參考照片，請先移除一張照片。');
                  return;
                }
                update({ models: selected });
              }}
              estimates={estimates}
              showMoney={showMoney}
            />
            <p className="hint">每個 AI 都會使用同一段描述來建立成品。</p>
            {!video && draft.models.includes('grok') && (
              <p className="hint">Grok 最多使用 3 張參考照片。</p>
            )}
          </section>
          <section className="card">
            <h2 className="section-label">
              <span className="step">03</span>畫面的樣子
            </h2>
            {video && draft.refs.length > 0 ? (
              <p className="hint">
                影片比例依起始照片調整，實際尺寸由模型決定。Gemini Omni 僅提供直向與橫向影片。
              </p>
            ) : (
              <fieldset>
                <legend>{mediaName}比例</legend>
                <div className="ratio-options">
                  {(['portrait', 'square', 'landscape'] as const).map((ratio, index) => (
                    <button
                      key={ratio}
                      type="button"
                      aria-pressed={draft.ratio === ratio}
                      disabled={
                        video &&
                        ratio === 'square' &&
                        draft.models.some((model) => !supportsSquareVideo(model))
                      }
                      onClick={() => update({ ratio })}
                    >
                      <span className={`ratio-shape ${ratio}`} />
                      <strong>{['手機直向', '方形', '橫向'][index]}</strong>
                      <small>{['約 9 : 16', '1 : 1', '約 16 : 9'][index]}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {!video && (
              <div className="setting-row">
                <label htmlFor="resolution">
                  清晰度<small>較高解析度需要更多時間</small>
                </label>
                <select
                  id="resolution"
                  value={draft.resolution}
                  onChange={(e) => update({ resolution: e.target.value as Draft['resolution'] })}
                >
                  <option value="1K">標準 · 1K</option>
                  <option value="2K">細緻 · 2K</option>
                </select>
              </div>
            )}
            {video && (
              <>
                <label className="setting-row">
                  影片長度
                  <select
                    value={draft.duration ?? 4}
                    onChange={(e) => update({ duration: Number(e.target.value) })}
                  >
                    {[4, 6, 8].map((seconds) => (
                      <option value={seconds} key={seconds}>
                        {seconds} 秒
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">
                  預設生成聲音；解析度與關閉聲音可在進階設定中分別調整。聲音由 AI
                  配合畫面生成，不保證對白逐字準確。
                </p>
              </>
            )}
            {!video && draft.models.some((model) => model === 'grok' || model === 'muse') && (
              <p className="hint">
                Grok 的清晰度在進階設定中獨立調整；Muse 固定約
                2K。有照片時，這兩個模型會沿用照片比例。
              </p>
            )}
            {advancedModels.length > 0 && (
              <details className="advanced">
                <summary>
                  <Settings2 size={17} />
                  進階設定
                  <ChevronDown size={17} />
                </summary>
                {advancedModels.map((model) => (
                  <div className="advanced-model" key={model}>
                    <strong>{models[model].name}</strong>
                    <small>
                      {(video || model === 'grok' || model === 'muse') && draft.refs.length
                        ? '依照片決定尺寸'
                        : `輸出 ${dimensions(model, draft).width} × ${dimensions(model, draft).height} px`}{' '}
                      · {video ? 'MP4' : 'PNG'}
                    </small>
                    {model === 'grok' && (
                      <>
                        <label className="setting-row">
                          解析度
                          <select
                            aria-label="Grok 解析度"
                            value={draft.grokResolution ?? draft.resolution}
                            onChange={(e) =>
                              update({ grokResolution: e.target.value as Draft['grokResolution'] })
                            }
                          >
                            <option value="1K">標準 · 1K</option>
                            <option value="2K">細緻 · 2K</option>
                          </select>
                        </label>
                        <label className="setting-row">
                          繪製品質
                          <select
                            aria-label="Grok 繪製品質"
                            value={draft.grokQuality ?? 'medium'}
                            onChange={(e) =>
                              update({ grokQuality: e.target.value as Draft['grokQuality'] })
                            }
                          >
                            <option value="low">快速 · low</option>
                            <option value="medium">細緻 · medium</option>
                          </select>
                        </label>
                      </>
                    )}
                    {model === 'muse' && <p className="hint">固定約 2K，依比例調整尺寸。</p>}
                    {video && (
                      <>
                        <label className="setting-row">
                          解析度
                          <select
                            aria-label={`${models[model].name} 解析度`}
                            value={videoResolutionFor(model, draft)}
                            onChange={(e) =>
                              update({
                                videoResolutions: {
                                  ...draft.videoResolutions,
                                  [model]: e.target.value,
                                },
                              })
                            }
                          >
                            {videoResolutionOptions(model).map((resolution) => (
                              <option key={resolution} value={resolution}>
                                {resolution === '1440p' ? '1440p · 2K' : resolution}
                              </option>
                            ))}
                          </select>
                        </label>
                        {fixedVideoAudio(model) ? (
                          <p className="hint">固定有聲，模型不提供關閉聲音。</p>
                        ) : (
                          <label className="check-row">
                            <input
                              type="checkbox"
                              aria-label={`${models[model].name} 關閉聲音`}
                              checked={!videoAudioFor(model, draft)}
                              onChange={(e) =>
                                update({
                                  videoAudio: { ...draft.videoAudio, [model]: !e.target.checked },
                                })
                              }
                            />
                            關閉聲音
                          </label>
                        )}
                      </>
                    )}
                    {model === 'banana' ? (
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={draft.googleSearch}
                          onChange={(e) => update({ googleSearch: e.target.checked })}
                        />
                        參考網路資料生成圖片
                      </label>
                    ) : model === 'gpt' || model === 'gptFlare' || model === 'gptSunburst' ? (
                      <>
                        <label className="setting-row">
                          繪製品質
                          <select
                            value={draft.gptQuality}
                            onChange={(e) =>
                              update({ gptQuality: e.target.value as Draft['gptQuality'] })
                            }
                          >
                            <option value="auto">自動</option>
                            <option value="low">快速</option>
                            <option value="medium">標準</option>
                            <option value="high">精細</option>
                          </select>
                        </label>
                        <label className="setting-row">
                          背景
                          <select
                            value={draft.gptBackground}
                            onChange={(e) =>
                              update({ gptBackground: e.target.value as Draft['gptBackground'] })
                            }
                          >
                            <option value="auto">自動</option>
                            <option value="opaque">一般背景</option>
                            <option value="transparent">透明背景</option>
                          </select>
                        </label>
                      </>
                    ) : model === 'seedream' ? (
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={draft.seedreamThinking ?? true}
                          onChange={(e) => update({ seedreamThinking: e.target.checked })}
                        />
                        加強構思（可能需要更多時間）
                      </label>
                    ) : model === 'kling' ? (
                      <label className="setting-row">
                        不想出現的內容
                        <input
                          value={draft.klingNegativePrompt ?? ''}
                          maxLength={2500}
                          onChange={(e) => update({ klingNegativePrompt: e.target.value })}
                          placeholder="例如：鏡頭晃動"
                        />
                      </label>
                    ) : null}
                  </div>
                ))}
              </details>
            )}
          </section>
          <section className="card quantity-card">
            <h2 className="section-label">
              <span className="step">04</span>這次想要幾{unit}？
            </h2>
            <div className="quantity-controls">
              <div>
                <span>每個 AI 生成</span>
                <small>多一{unit}，多一種可能</small>
              </div>
              <div className="stepper">
                <button
                  aria-label={video ? '減少支數' : '減少張數'}
                  disabled={draft.count <= 1}
                  onClick={() => update({ count: draft.count - 1 })}
                >
                  <Minus size={19} />
                </button>
                <span>
                  <AnimatedNumber value={draft.count} /> {unit}
                </span>
                <button
                  aria-label={video ? '增加支數' : '增加張數'}
                  disabled={draft.count >= (video ? 2 : 4)}
                  onClick={() => update({ count: draft.count + 1 })}
                >
                  <Plus size={19} />
                </button>
              </div>
            </div>
          </section>
          <div className="submit-bar">
            <div className="submit-summary">
              <span className="count-equation">
                <span>
                  <AnimatedNumber value={draft.models.length} /> 個 AI{' '}
                  <span className="times">×</span> 各 <AnimatedNumber value={draft.count} /> {unit}
                </span>
                <span className="times">=</span>
                <span className="total-count">
                  <AnimatedNumber value={total} /> {unit}作品
                </span>
              </span>
              {showMoney && draft.models.length > 0 && (
                <small className="cost-summary">
                  {priceLoading
                    ? '正在查詢預估費用…'
                    : unknownPrices.length
                      ? `總費用暫無法預估：${unknownPrices.map((model) => `${models[model].name} ${estimates[model]?.reason}`).join('；')}`
                      : `預估費用 ${money(estimatedCost)} · 完成後依實際用量計費`}
                </small>
              )}
            </div>
            <button
              className="primary full generate"
              disabled={
                submitting ||
                active ||
                uploading ||
                !draft.models.length ||
                draft.prompt.trim().length < 3 ||
                draft.prompt.length > promptLimit(draft)
              }
              onClick={() => void submit()}
            >
              {submitting || active ? <LoaderCircle className="spin" /> : <Sparkles size={20} />}
              {submitting
                ? '正在送出…'
                : active
                  ? '作品正在生成中'
                  : video
                    ? '開始生成影片'
                    : draft.refs.length
                      ? '開始修改照片'
                      : '開始生成圖片'}
              {!active && !submitting && <ArrowRight size={19} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="results" role="tabpanel" aria-label="本次作品">
          {!jobs.length ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Images size={31} />
              </div>
              <h2>美好的作品，從一個想法開始</h2>
              <p>回到編輯畫面，寫下想創作的內容吧。</p>
              <button className="secondary" onClick={() => setTab('edit')}>
                <ArrowLeft size={17} /> 開始編輯
              </button>
            </div>
          ) : (
            <>
              <div className="results-heading">
                <h2>本次作品</h2>
                <span>
                  {jobs.filter((j) => j.status === 'succeeded').length} {unit}作品
                </span>
              </div>
              {[...new Set(jobs.map((j) => j.batchId))].reverse().map((batch, index) => (
                <section className="batch" key={batch}>
                  <div className="batch-heading">
                    <span>第 {new Set(jobs.map((j) => j.batchId)).size - index} 次生成</span>
                    <small>{date(jobs.find((j) => j.batchId === batch)!.createdAt)}</small>
                  </div>
                  <p className="batch-prompt">
                    {jobs.find((j) => j.batchId === batch)!.draft.prompt}
                  </p>
                  <div className="result-grid">
                    {jobs
                      .filter((j) => j.batchId === batch)
                      .map((job) => (
                        <article className="result-card" key={job.id}>
                          {job.status === 'succeeded' && job.mediaId ? (
                            <button
                              className="result-image"
                              aria-label={`檢視 ${models[job.model].name} ${mediaName}`}
                              onClick={() => openImage(job)}
                            >
                              <LocalImage id={job.mediaId} alt={job.draft.prompt} />
                              {video && (
                                <span className="zoom-hint">
                                  <Play size={16} />
                                  播放
                                </span>
                              )}
                            </button>
                          ) : (
                            <div className={`job-placeholder ${job.status}`}>
                              {isActive(job) ? (
                                <>
                                  <LoaderCircle className="spin" size={27} />
                                  <strong>{video ? '正在製作影片' : '正在為你作畫'}</strong>
                                  <span>稍等一下，靈感正在成形</span>
                                </>
                              ) : (
                                <>
                                  <Images size={28} />
                                  <strong>
                                    {job.status === 'failed'
                                      ? video
                                        ? '這支影片尚未完成'
                                        : '這張圖尚未完成'
                                      : job.status === 'retrieval_failed'
                                        ? '成果下載失敗'
                                        : '等待確認結果'}
                                  </strong>
                                  <span>{job.message}</span>
                                  {job.status === 'failed' && hasCreditFailure(job) ? (
                                    <button className="secondary" onClick={() => setTab('edit')}>
                                      回到編輯畫面
                                    </button>
                                  ) : job.status === 'failed' ? (
                                    <button
                                      className="secondary"
                                      disabled={submitting || active}
                                      onClick={() => {
                                        if (
                                          confirm(
                                            `重新生成這${unit}${mediaName}？這會送出新的生成請求。`,
                                          )
                                        )
                                          void submit({
                                            ...job.draft,
                                            models: [job.model],
                                            count: 1,
                                          });
                                      }}
                                    >
                                      {video ? '重新生成這支' : '重新生成這張'}
                                    </button>
                                  ) : (
                                    <button
                                      className="secondary"
                                      onClick={async () => {
                                        if (!apiKey) {
                                          notify('請先到右上角的設定，輸入 API Key 後再查詢。');
                                          return;
                                        }
                                        if (job.keyTag !== (await keyTag(apiKey))) {
                                          notify(
                                            '請切換回當時使用的 Key，才能查詢原任務。備份紀錄無法查詢。',
                                          );
                                          return;
                                        }
                                        void runJob(job.id, apiKey);
                                        notify('正在查詢原任務，不會重新生成。');
                                      }}
                                    >
                                      {job.status === 'retrieval_failed'
                                        ? '重試取得成果'
                                        : '查詢原任務'}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                          <div className="result-meta">
                            <ProviderLogo model={job.model} />
                            <strong>{models[job.model].name}</strong>
                            {job.status === 'succeeded' && <Check size={14} />}
                          </div>
                          {showMoney && job.status === 'succeeded' && (
                            <p className="result-cost">
                              實際費用 {job.cost !== undefined ? money(job.cost) : '服務商未提供'}
                            </p>
                          )}
                        </article>
                      ))}
                  </div>
                </section>
              ))}
              <div className="local-note">{STORAGE_NOTE}</div>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default function App({ linkedKey = '' }: { linkedKey?: string }) {
  const [pendingLinkedKey, setPendingLinkedKey] = useState(linkedKey);
  const topbarRef = useRef<HTMLElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    const measure = () => {
      topbar.parentElement?.style.setProperty(
        '--topbar-height',
        `${topbar.getBoundingClientRect().height}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(topbar);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);
  const [apiKey, setApiKey] = useState(readKey);
  const [showHomeTour, setShowHomeTour] = useState(false);
  const [guestMode, setGuestMode] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [screen, setScreen] = useState<Screen>('home');
  const rekeying = screen === 'key';
  const [workTab, setWorkTab] = useState<WorkTab>('edit');
  const [works, setWorks] = useState<Work[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workId, setWorkId] = useState('');
  const [chatId, setChatId] = useState('');
  const [chatActive, setChatActive] = useState(false);
  const [settings, setSettings] = useState(false);
  const [imageJob, setImageJob] = useState<Job | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState<{ width: number; height: number } | null>(null);
  const [libraryLimit, setLibraryLimit] = useState(10);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSequence = useRef(0);
  const [dataBusy, setDataBusy] = useState(false);
  const pwa = usePwa();
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [openBackupOnSettings, setOpenBackupOnSettings] = useState(false);
  const backupDetails = useRef<HTMLDetailsElement>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [loading, setLoading] = useState(true);
  const [databaseUpgradeBlocked, setDatabaseUpgradeBlocked] = useState(isDatabaseUpgradeBlocked);
  const [storageError, setStorageError] = useState(false);
  const [connectionState, setConnectionState] = useState<
    'unset' | 'checking' | 'ready' | 'invalid' | 'unavailable'
  >(apiKey ? 'checking' : 'unset');
  const [storageBytes, setStorageBytes] = useState<number | null>();
  const active = jobs.some(isActive) || chatActive;
  useEffect(() => {
    if (settings && openBackupOnSettings) {
      if (backupDetails.current) backupDetails.current.open = true;
      setOpenBackupOnSettings(false);
    }
  }, [settings, openBackupOnSettings]);
  useEffect(() => {
    if (!chatActive) return;
    // A closing tab can release its lock after the focus event in the surviving tab.
    const timer = window.setInterval(() => {
      void recoverChatSessions().catch(() => setStorageError(true));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [chatActive]);
  const notify = useCallback<Notify>(
    (message) => setToast({ id: ++toastSequence.current, message }),
    [],
  );
  const enteredStudio = Boolean(apiKey || guestMode);
  useEffect(() => {
    if (
      enteredStudio &&
      screen === 'home' &&
      !loading &&
      !settings &&
      !pendingLinkedKey &&
      !localStorage.getItem(HOME_TOUR_KEY)
    )
      setShowHomeTour(true);
  }, [enteredStudio, screen, loading, settings, pendingLinkedKey]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const balanceSequence = useRef(0);
  const balanceRequest = useRef<{ key: string; sequence: number } | null>(null);
  const applyNavigation = useCallback((state: NavigationState) => {
    // Accept history entries created before key setup became a regular screen.
    setScreen(state.overlay === 'key' ? 'key' : state.screen);
    setWorkId(state.workId ?? '');
    setChatId(state.sessionId ?? '');
    setWorkTab(state.workTab ?? 'edit');
    setSettings(state.overlay === 'settings');
    setFullscreen(state.overlay === 'fullscreen');
    setReferenceId(state.overlay === 'fullscreen' ? (state.referenceId ?? null) : null);
    setImageJob(
      (state.overlay === 'viewer' || state.overlay === 'fullscreen') && state.jobId
        ? (jobsRef.current.find((job) => job.id === state.jobId) ?? null)
        : null,
    );
    window.scrollTo({ top: 0 });
  }, []);
  const navigate = useCallback(
    (next: Omit<NavigationState, 'studio'>) => {
      const state: NavigationState = { studio: true, ...next };
      history.pushState(state, '');
      applyNavigation(state);
    },
    [applyNavigation],
  );
  const closeOverlay = useCallback((overlay: NavigationState['overlay']) => {
    const state = history.state as NavigationState | null;
    if (state?.studio && state.overlay === overlay) history.back();
    else {
      setSettings(false);
      setImageJob(null);
      setFullscreen(false);
      setReferenceId(null);
    }
  }, []);

  useEffect(() => {
    const initial: NavigationState = { studio: true, screen: 'home' };
    if (!(history.state as NavigationState | null)?.studio) history.replaceState(initial, '');
    else applyNavigation(history.state as NavigationState);
    const pop = (event: PopStateEvent) => {
      const state = event.state as NavigationState | null;
      applyNavigation(state?.studio ? state : initial);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [applyNavigation]);
  const refreshBalance = useCallback(async () => {
    if (!apiKey || !navigator.onLine) {
      ++balanceSequence.current;
      balanceRequest.current = null;
      setBalance(null);
      setBalanceLoading(false);
      setConnectionState(apiKey ? 'unavailable' : 'unset');
      return;
    }
    if (balanceRequest.current?.key === apiKey) return;
    const sequence = ++balanceSequence.current;
    balanceRequest.current = { key: apiKey, sequence };
    setBalanceLoading(true);
    setConnectionState('checking');
    try {
      const value = await fetchBalance(apiKey);
      if (sequence === balanceSequence.current) {
        setBalance(value);
        setConnectionState('ready');
      }
    } catch (error) {
      if (sequence === balanceSequence.current) {
        setBalance(null);
        setConnectionState(
          error instanceof ApiError && isCredentialError(error.code) ? 'invalid' : 'unavailable',
        );
      }
    } finally {
      if (sequence === balanceSequence.current) setBalanceLoading(false);
      if (balanceRequest.current?.sequence === sequence) balanceRequest.current = null;
    }
  }, [apiKey]);

  useEffect(() => {
    const blocked = () => setDatabaseUpgradeBlocked(true);
    window.addEventListener('studio-db-blocked', blocked);
    if (isDatabaseUpgradeBlocked()) blocked();
    return () => window.removeEventListener('studio-db-blocked', blocked);
  }, []);
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const load = async () => {
      const ticket = ++sequence;
      try {
        const [result, chats] = await Promise.all([snapshot(), listChatSessions()]);
        if (live && ticket === sequence) {
          setChatActive(chats.some(isChatSessionActive));
          setWorks(result.works);
          setJobs(result.jobs);
          setStorageError(false);
        }
      } catch {
        if (live) setStorageError(true);
      } finally {
        if (live) setLoading(false);
      }
    };
    void recoverChatSessions()
      .then(load)
      .catch(() => {
        if (live) {
          setStorageError(true);
          setLoading(false);
        }
      });
    const recover = () => {
      void recoverChatSessions().catch(() => {
        if (live) setStorageError(true);
      });
    };
    window.addEventListener('focus', recover);
    window.addEventListener('studio-change', load);
    return () => {
      live = false;
      window.removeEventListener('focus', recover);
      window.removeEventListener('studio-change', load);
    };
  }, []);
  useEffect(() => {
    try {
      savePreferences(preferences);
    } catch {
      notify('偏好無法保存，請確認瀏覽器允許本機儲存。');
    }
  }, [preferences, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        !['img-generator.key', 'img-generator.preferences'].includes(event.key)
      )
        return;
      setApiKey(readKey());
      setPreferences(readPreferences());
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, []);
  useEffect(() => {
    ++balanceSequence.current;
    balanceRequest.current = null;
    setBalance(null);
    setBalanceLoading(false);
    void refreshBalance();
    return () => {
      ++balanceSequence.current;
    };
  }, [refreshBalance]);
  useEffect(() => {
    const refresh = () => void refreshBalance();
    window.addEventListener('chat-finished', refresh);
    return () => window.removeEventListener('chat-finished', refresh);
  }, [refreshBalance]);
  useEffect(() => {
    if (!settings) return;
    let live = true;
    let sequence = 0;
    const refreshStorage = async () => {
      const ticket = ++sequence;
      try {
        const bytes = await storageUsage();
        if (live && ticket === sequence) setStorageBytes(bytes);
      } catch {
        if (live && ticket === sequence) setStorageBytes(null);
      }
    };
    setStorageBytes(undefined);
    void refreshStorage();
    window.addEventListener('studio-change', refreshStorage);
    return () => {
      live = false;
      window.removeEventListener('studio-change', refreshStorage);
    };
  }, [settings]);
  const completed = jobs.filter((j) => j.status === 'succeeded').length;
  useEffect(() => {
    if (completed) void refreshBalance();
  }, [completed, refreshBalance]);
  useEffect(() => {
    const recover = () => {
      setOffline(!navigator.onLine);
      void refreshBalance();
      if (apiKey && navigator.onLine) void resumeJobs(apiKey).catch(() => setStorageError(true));
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    recover();
    window.addEventListener('online', recover);
    window.addEventListener('offline', recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', recover);
      window.removeEventListener('offline', recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [apiKey, refreshBalance]);

  useEffect(() => {
    setActualSize(null);
  }, [imageJob?.mediaId]);
  useEffect(() => {
    if (screen !== 'library') setLibraryLimit(10);
  }, [screen]);
  const listedWorks = visibleWorks(works, jobs);
  const openWork = (work: Work, tab?: WorkTab) =>
    navigate({
      screen: 'work',
      workId: work.id,
      workTab: tab ?? (jobs.some((job) => job.workId === work.id) ? 'results' : 'edit'),
    });
  const createWork = async (ref?: string, kind: WorkKind = 'image') => {
    try {
      const draft = rememberedDraft(kind);
      if (ref) draft.refs = [ref];
      const work: Work = {
        id: crypto.randomUUID(),
        title: ref ? '從照片開始的新作品' : '還沒命名的作品',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        draft,
      };
      await saveWork(work);
      setWorks((previous) => [work, ...previous.filter((w) => w.id !== work.id)]);
      openWork(work, 'edit');
      void navigator.storage?.persist?.().catch(() => {});
    } catch {
      notify('無法建立作品，請檢查裝置儲存空間。');
    }
  };
  const current = works.find((w) => w.id === workId);
  const updateKey = (key: string) => {
    setPendingLinkedKey('');
    const replacing = Boolean(apiKey);
    setApiKey(key);
    setGuestMode(false);
    setConnectionState('checking');
    if (key === apiKey) void refreshBalance();
    if (replacing) notify('已更換 API Key。');
    const homeState: NavigationState = { studio: true, screen: 'home' };
    history.replaceState(homeState, '');
    applyNavigation(homeState);
  };
  const enterKeySetup = () => {
    const state: NavigationState = { studio: true, screen: 'key' };
    history.replaceState(state, '');
    applyNavigation(state);
  };
  const openBackupSettings = () => {
    setGuestMode(true);
    setOpenBackupOnSettings(true);
    navigate({ screen: 'home', overlay: 'settings' });
  };
  const exportLocalBackup = async () => {
    setDataBusy(true);
    try {
      download(await exportBackup(), `little-studio-${new Date().toISOString().slice(0, 10)}.zip`);
      notify('備份已準備好，請保存下載的 ZIP 檔。');
    } catch {
      notify('匯出失敗，可能是記憶體或儲存空間不足。請先個別下載重要作品。');
    } finally {
      setDataBusy(false);
    }
  };
  const connectionLabel = {
    unset: '未設定服務',
    checking: '檢查中',
    ready: '服務已就緒',
    invalid: '金鑰不可用',
    unavailable: '暫時無法確認',
  }[connectionState];
  const deleteWork = async (work: Work) => {
    if (jobs.some((j) => j.workId === work.id && isActive(j))) {
      notify('請等生成完成後再刪除。');
      return;
    }
    if (
      !confirm(
        `刪除「${work.title}」及其中的生成紀錄？這只刪除本機資料，無法復原，也不會取消服務商的任務。`,
      )
    )
      return;
    try {
      await removeWork(work.id);
      if (workId === work.id) navigate({ screen: 'library' });
      notify('已刪除這份作品。');
    } catch {
      notify('刪除失敗，請稍後再試。');
    }
  };

  return (
    <main className={`shell${screen === 'chat' && enteredStudio ? ' chat-shell' : ''}`}>
      <div className="landscape-lock" role="status">
        <Smartphone size={46} />
        <strong>請將手機轉回直向</strong>
        <span>直向畫面比較容易操作畫室。</span>
      </div>
      <header className="topbar" ref={topbarRef}>
        <button
          ref={brandRef}
          className="brand"
          onClick={() => navigate({ screen: 'home' })}
          aria-label="種子畫廊首頁"
        >
          <img
            className="brand-symbol"
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            width={44}
            height={44}
          />
          <span>
            種子畫廊<small>one seed, many possibilities</small>
          </span>
        </button>
        {enteredStudio && (
          <div className="header-tools">
            <div className="header-status">
              <button
                className={`connected ${connectionState}`}
                aria-label={`服務狀態：${connectionLabel}`}
                title={apiKey ? `${connectionLabel}，點此重新檢查` : '未設定服務，點此開啟設定'}
                onClick={() =>
                  apiKey
                    ? void refreshBalance()
                    : navigate({ screen, workId, workTab, sessionId: chatId, overlay: 'settings' })
                }
                disabled={balanceLoading}
              >
                <span />
                <b>{connectionLabel}</b>
              </button>
              {apiKey && preferences.showMoney && (
                <MoneyBadge
                  balance={balance}
                  loading={balanceLoading}
                  refresh={() => void refreshBalance()}
                />
              )}
            </div>
            <button
              className="icon-button settings-button"
              aria-label="設定"
              onClick={() =>
                navigate({
                  screen,
                  sessionId: chatId,
                  ...(workId ? { workId, workTab } : {}),
                  overlay: 'settings',
                })
              }
            >
              <Settings2 size={21} />
            </button>
          </div>
        )}
      </header>
      {showHomeTour && enteredStudio && screen === 'home' && !loading && !settings && (
        <HomeTour
          target={brandRef.current}
          onDismiss={() => {
            localStorage.setItem(HOME_TOUR_KEY, '1');
            setShowHomeTour(false);
          }}
        />
      )}
      {offline && (
        <div className="notice" role="status">
          目前離線。已完整保存在這個 App 的作品仍可瀏覽；生成圖片、影片、聊天與其他 API
          功能需要網路。
        </div>
      )}
      {pwa.waiting && (
        <div className="pwa-update notice" role="status">
          <span>新版本已準備好。完成編輯、生成與備份後，回到首頁或我的作品再更新。</span>
          {pwa.updateBlocked && <span>請先關閉其他已開啟的種子畫廊頁面，再按一次更新。</span>}
          {(screen === 'home' || screen === 'library') &&
            enteredStudio &&
            !settings &&
            !active &&
            !dataBusy &&
            !loading && (
              <button className="secondary" onClick={pwa.applyUpdate}>
                更新並重新開啟
              </button>
            )}
        </div>
      )}
      {pwa.standalone && pwa.isIos && !listedWorks.length && !loading && (
        <div className="pwa-transfer notice">
          若你曾在 Safari 使用，主畫面 App 的資料與 Safari 分開保存。請重新輸入 Key，並
          <button className="text-button" onClick={openBackupSettings}>
            還原 Safari 匯出的備份
          </button>
          。
        </div>
      )}
      {storageError && (
        <div className="error" role="alert">
          無法讀取本機儲存。請確認瀏覽器允許儲存資料，暫時不要清除瀏覽器資料。
        </div>
      )}
      {pendingLinkedKey ? (
        <LinkedKeySetup
          linkedKey={pendingLinkedKey}
          existingKey={apiKey}
          onSuccess={updateKey}
          onCancel={() => setPendingLinkedKey('')}
        />
      ) : rekeying || !enteredStudio ? (
        <Welcome
          key={`${enteredStudio ? 'studio' : 'entry'}:${rekeying ? 'rekey' : 'welcome'}`}
          onSuccess={updateKey}
          onSkip={() => {
            setGuestMode(true);
            navigate({ screen: 'home' });
          }}
          returning={enteredStudio}
          replacing={rekeying && Boolean(apiKey)}
        />
      ) : loading ? (
        <div className="empty-state">
          {databaseUpgradeBlocked ? (
            <>
              <h2>請關閉其他種子畫廊頁面</h2>
              <p>
                另一個分頁或主畫面 App 正占用本機資料。關閉後，這裡會繼續載入；作品不會因此刪除。
              </p>
              <button className="secondary" onClick={() => location.reload()}>
                重新讀取
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" />
              正在打開畫室…
            </>
          )}
        </div>
      ) : (
        <>
          {screen === 'chat' && (
            <Suspense
              fallback={
                <div className="empty-state">
                  <LoaderCircle className="spin" />
                  正在打開對話…
                </div>
              }
            >
              <ChatWorkspace
                apiKey={apiKey}
                showMoney={preferences.showMoney}
                sessionId={chatId}
                systemPrompt={preferences.chatSystemPrompt ?? ''}
                chatMode={effectiveChatMode(preferences)}
                chatModeControls={preferences.chatModeControls ?? false}
                onChatMode={(mode) =>
                  setPreferences((previous) => ({
                    ...previous,
                    chatMode: previous.chatModeControls ? mode : 'balanced',
                  }))
                }
                onNavigate={(id) => navigate({ screen: 'chat', sessionId: id })}
                onSettings={() =>
                  navigate({ screen: 'chat', sessionId: chatId, overlay: 'settings' })
                }
                notify={notify}
              />
            </Suspense>
          )}
          {screen === 'home' && (
            <>
              <button
                className="create-card home-first-card"
                onClick={() => void createWork()}
                disabled={storageError}
              >
                <div className="create-copy">
                  <h2>製作圖片</h2>
                  <p>
                    把文字變成畫面，
                    <br />
                    或為照片換一個新模樣。
                  </p>
                  <span className="create-cta">
                    開始創作 <ArrowRight size={19} />
                  </span>
                </div>
                <HomeIllustration kind="image" />
              </button>
              <button
                className="create-card video-create-card"
                onClick={() => void createWork(undefined, 'video')}
                disabled={storageError}
              >
                <div className="create-copy">
                  <h2>製作影片</h2>
                  <p>
                    讓文字成為短片，
                    <br />
                    也讓喜歡的照片動起來。
                  </p>
                  <span className="create-cta">
                    開始創作 <ArrowRight size={19} />
                  </span>
                </div>
                <HomeIllustration kind="video" />
              </button>
              <button
                className="create-card chat-create-card"
                disabled={storageError}
                onClick={() => navigate({ screen: 'chat' })}
              >
                <div className="create-copy">
                  <h2>聊天問答</h2>
                  <p>
                    問問生活大小事，
                    <br />
                    一起整理想法與靈感。
                  </p>
                  <span className="create-cta">
                    開始聊天 <ArrowRight size={19} />
                  </span>
                </div>
                <HomeIllustration kind="chat" />
              </button>
              <button className="library-link" onClick={() => navigate({ screen: 'library' })}>
                <span className="library-icon">
                  <FolderHeart size={25} />
                </span>
                <div>
                  <strong>我的作品</strong>
                  <small>
                    {listedWorks.length} 份創作，{completed} 個保存在瀏覽器的成果
                  </small>
                </div>
                <ArrowRight size={19} />
              </button>
              {listedWorks.length > 0 && (
                <section className="recent">
                  <div className="section-row">
                    <h2>最近使用</h2>
                  </div>
                  {listedWorks.slice(0, 3).map((work) => (
                    <button className="recent-work" key={work.id} onClick={() => openWork(work)}>
                      <span className="recent-thumbnail">
                        {workPreview(work, jobs) ? (
                          <LocalImage id={workPreview(work, jobs)!} alt="作品預覽" />
                        ) : (
                          <Images size={23} />
                        )}
                      </span>
                      <div>
                        <strong className={isSystemTitle(work.title) ? 'system-title' : undefined}>
                          {work.title}
                        </strong>
                        <small>{date(work.updatedAt)}</small>
                      </div>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </section>
              )}
              {(pwa.canInstall || (pwa.isIos && !pwa.standalone)) && (
                <section className="pwa-install-card">
                  <div className="pwa-install-intro">
                    <img
                      src={`${import.meta.env.BASE_URL}icon-192.png`}
                      alt=""
                      width={56}
                      height={56}
                    />
                    <div>
                      <strong>放到手機主畫面</strong>
                      <p>像 App 一樣開啟種子畫廊，也能在離線時查看這個 App 已保存的作品。</p>
                    </div>
                  </div>
                  {pwa.canInstall ? (
                    <button className="secondary" onClick={() => void pwa.install()}>
                      安裝 App
                    </button>
                  ) : (
                    <>
                      <button
                        className="secondary"
                        onClick={() => setShowInstallGuide((value) => !value)}
                      >
                        {showInstallGuide ? '收起步驟' : '查看加入步驟'}
                      </button>
                      {showInstallGuide && (
                        <div className="pwa-install-guide">
                          <p>
                            iOS 主畫面 App 的資料與 Safari
                            分開保存。若已有作品，請先匯出備份；安裝後在 App 的「設定 →
                            備份與重置」還原，並重新輸入 Key。
                          </p>
                          <button
                            className="secondary"
                            disabled={dataBusy || active}
                            onClick={() => void exportLocalBackup()}
                          >
                            <ArrowDownToLine size={17} />
                            匯出備份
                          </button>
                          <p>
                            {pwa.isSafari
                              ? '在 Safari 點「分享」→「加入主畫面」，開啟「打開為網頁 App」，最後點「加入」。'
                              : '請先用 Safari 開啟此網站，再點「分享」→「加入主畫面」。'}
                          </p>
                          <small>
                            本機保存不是永久備份；離線不能生成，也不保證切到背景後繼續執行。
                          </small>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
          {screen === 'work' && current && (
            <Workspace
              key={`${current.id}:${workTab}`}
              work={current}
              jobs={jobs.filter((j) => j.workId === current.id)}
              historyJobs={jobs}
              refreshBalance={() => void refreshBalance()}
              apiKey={apiKey}
              showMoney={preferences.showMoney}
              initialTab={workTab}
              notify={notify}
              openReference={(referenceId) =>
                navigate({
                  screen: 'work',
                  workId: current.id,
                  workTab,
                  overlay: 'fullscreen',
                  referenceId,
                })
              }
              openImage={(job) =>
                navigate({
                  screen: 'work',
                  workId: current.id,
                  workTab,
                  overlay: 'viewer',
                  jobId: job.id,
                })
              }
            />
          )}
          {screen === 'work' && !current && (
            <div className="empty-state">
              <h2>這份作品已移除</h2>
              <button className="secondary" onClick={() => navigate({ screen: 'library' })}>
                回到我的作品
              </button>
            </div>
          )}
          {screen === 'library' && (
            <>
              <div className="page-heading compact-heading">
                <h1>我的作品</h1>
              </div>
              {!listedWorks.length ? (
                <div className="empty-state">
                  <FolderHeart size={40} />
                  <p>還沒有作品，開始第一次創作吧。</p>
                </div>
              ) : (
                <div className="work-list">
                  {listedWorks.slice(0, libraryLimit).map((work) => {
                    const preview = workPreview(work, jobs);
                    return (
                      <article className="saved-work" key={work.id}>
                        <button onClick={() => openWork(work)} className="work-open">
                          {preview ? (
                            <LocalImage id={preview} alt={work.title} />
                          ) : (
                            <div className="work-empty">
                              <Images size={30} />
                            </div>
                          )}
                          <div>
                            <h2 className={isSystemTitle(work.title) ? 'system-title' : undefined}>
                              {work.title}
                            </h2>
                            <p>{date(work.updatedAt)}</p>
                            <span>
                              {
                                jobs.filter((j) => j.workId === work.id && j.status === 'succeeded')
                                  .length
                              }{' '}
                              {isVideo(work.draft) ? '支影片' : '張圖片'}
                            </span>
                          </div>
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`刪除 ${work.title}`}
                          disabled={jobs.some((j) => j.workId === work.id && isActive(j))}
                          onClick={() => void deleteWork(work)}
                        >
                          <Trash2 size={18} />
                        </button>
                      </article>
                    );
                  })}
                  {listedWorks.length > libraryLimit && (
                    <button
                      className="secondary full"
                      onClick={() => setLibraryLimit((limit) => limit + 10)}
                    >
                      顯示更多
                    </button>
                  )}
                </div>
              )}
              <p className="hint library-storage-note">{STORAGE_NOTE}</p>
            </>
          )}
        </>
      )}
      <footer>
        <a href={REPO} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>{' '}
          GitHub
        </a>
      </footer>
      {toast && !settings && !imageJob && <Toast notice={toast} />}
      {enteredStudio && settings && (
        <Modal
          title="設定"
          notice={toast}
          close={() => {
            if (!dataBusy) closeOverlay('settings');
          }}
        >
          <div className="modal-content">
            {apiKey && preferences.showMoney && (
              <section className="balance-panel" aria-label="餘額使用進度">
                <div className="balance-panel-heading">
                  <div>
                    <span>目前餘額</span>
                    <strong>{balance ? money(balance.amount) : '暫時無法讀取'}</strong>
                  </div>
                  <label>
                    顯示上限
                    <span>
                      US$
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={preferences.balanceLimit}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value) && value > 0)
                            setPreferences({ ...preferences, balanceLimit: value });
                        }}
                        aria-label="餘額顯示上限"
                      />
                    </span>
                  </label>
                </div>
                <progress
                  max={preferences.balanceLimit}
                  value={Math.min(balance?.amount ?? 0, preferences.balanceLimit)}
                  aria-label="目前餘額相對於顯示上限"
                />
                <small>上限只用來顯示進度，不會限制實際生成費用。</small>
              </section>
            )}
            <details className="settings-section">
              <summary>
                顯示偏好 <ChevronDown size={17} />
              </summary>
              <div className="settings-section-body">
                <label className="toggle-row">
                  <span>
                    顯示餘額與費用<small>包含預估費用與實際生成費用</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={preferences.showMoney}
                    onChange={(e) =>
                      setPreferences({ ...preferences, showMoney: e.target.checked })
                    }
                  />
                </label>
              </div>
            </details>
            <details className="settings-section">
              <summary>
                聊天偏好 <ChevronDown size={17} />
              </summary>
              <div className="settings-section-body">
                <label className="chat-system-prompt">
                  系統提示詞
                  <textarea
                    rows={3}
                    maxLength={12000}
                    value={preferences.chatSystemPrompt ?? ''}
                    placeholder="例如：請用繁體中文，簡短回答。"
                    onChange={(event) =>
                      setPreferences({ ...preferences, chatSystemPrompt: event.target.value })
                    }
                  />
                </label>
                <p className="hint">告訴 AI 你希望它怎麼回答。</p>
                <div className="toggle-row">
                  <span>自訂思考模式</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="自訂思考模式"
                    aria-checked={preferences.chatModeControls ?? false}
                    className="chat-mode-switch"
                    onClick={() =>
                      setPreferences((previous) =>
                        setChatModeControls(previous, !previous.chatModeControls),
                      )
                    }
                  />
                </div>
                <p className="hint">開啟後可在聊天切換思考模式；關閉即重設為平衡。</p>
              </div>
            </details>
            <details className="settings-section">
              <summary>
                服務連線 <ChevronDown size={17} />
              </summary>
              <div className="settings-section-body">
                <p className="hint">
                  {apiKey
                    ? '已保存 Runware API Key。更換 Key 不會刪除作品，舊任務需用原 Key 查詢。'
                    : '尚未設定 Runware API Key；你可以先瀏覽作品，生成前再設定服務。'}
                </p>
                {apiKey && active ? (
                  <p className="notice">生成完成後即可更換或移除 Key。</p>
                ) : apiKey ? (
                  <div className="replace-key">
                    <button className="secondary full" onClick={enterKeySetup}>
                      重新輸入 API Key
                    </button>
                  </div>
                ) : (
                  <button className="secondary full" onClick={enterKeySetup}>
                    輸入 API Key
                  </button>
                )}
                <button
                  className="text-button danger"
                  disabled={!apiKey || active || dataBusy}
                  onClick={() => {
                    if (confirm('移除這台裝置的 API Key？作品會保留，下次使用需重新設定 Key。')) {
                      saveKey('');
                      setApiKey('');
                      setGuestMode(false);
                      closeOverlay('settings');
                    }
                  }}
                >
                  移除這台裝置的 Key
                </button>
              </div>
            </details>
            <details className="settings-section">
              <summary>
                作品儲存 <ChevronDown size={17} />
              </summary>
              <div className="settings-section-body">
                <section className="storage-summary" aria-label="作品暫存大小">
                  <span className="storage-symbol">
                    <FolderHeart size={24} aria-hidden="true" />
                  </span>
                  <span className="storage-label">作品佔用空間</span>
                  <strong>
                    {storageBytes === undefined
                      ? '計算中…'
                      : storageBytes === null
                        ? '暫時無法讀取'
                        : formatBytes(storageBytes)}
                  </strong>
                  <small>暫存在這個瀏覽器的參考照片、生成圖片、影片與聊天附件。</small>
                </section>
                <p className="hint">可以到「我的作品」刪除不需要的作品，釋出儲存空間。</p>
                <button
                  className="text-button danger"
                  disabled={active || dataBusy || loading}
                  onClick={async () => {
                    if (
                      !confirm(
                        '清除這台裝置的所有作品、聊天對話、附件與生成紀錄？Key 與顯示偏好會保留。此操作無法復原，請先匯出備份。',
                      )
                    )
                      return;
                    setDataBusy(true);
                    try {
                      await clearWorks();
                      const homeState: NavigationState = {
                        studio: true,
                        screen: 'home',
                        overlay: 'settings',
                      };
                      history.replaceState(homeState, '');
                      applyNavigation(homeState);
                      notify('已清除作品與對話，服務設定已保留。');
                    } catch {
                      notify('清除失敗，請稍後再試。');
                    } finally {
                      setDataBusy(false);
                    }
                  }}
                >
                  刪除所有作品與對話
                </button>
                <p className="hint">
                  刪除作品、對話與附件，保留 API Key 與偏好。刪除後無法復原，請先備份。
                </p>
              </div>
            </details>
            <details className="settings-section" ref={backupDetails}>
              <summary>
                備份與重置 <ChevronDown size={17} />
              </summary>
              <div className="settings-section-body">
                <p className="hint">
                  將作品與對話打包下載，換裝置時也能還原。備份包含照片、圖片、影片、聊天歷史、附件與設定，不含
                  API Key。
                </p>
                <div className="backup-actions">
                  <button
                    className="secondary"
                    disabled={dataBusy || active}
                    onClick={() => void exportLocalBackup()}
                  >
                    <ArrowDownToLine size={17} />
                    {dataBusy ? '處理中…' : '匯出備份'}
                  </button>
                  <label className={`secondary file-label ${dataBusy || active ? 'disabled' : ''}`}>
                    <FolderHeart size={17} />
                    還原備份
                    <input
                      aria-label="還原備份"
                      type="file"
                      accept=".zip,application/zip"
                      disabled={dataBusy || active}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setDataBusy(true);
                        try {
                          const count = await importBackup(file);
                          setPreferences(readPreferences());
                          notify(`已還原 ${count} 份作品與對話，原有資料也已保留。`);
                        } catch (err) {
                          notify(err instanceof Error ? err.message : '備份無法還原。');
                        } finally {
                          setDataBusy(false);
                        }
                      }}
                    />
                  </label>
                </div>
                <p className="hint">
                  還原會保留原有作品，並套用備份中的聊天系統提示詞。單次可匯入 250 MB 以內的
                  ZIP；重要成果也請另外下載保存。
                </p>
                <button
                  className="text-button danger"
                  disabled={active || dataBusy || loading}
                  onClick={async () => {
                    if (
                      !confirm(
                        '重設這台裝置？所有作品、對話、附件、Key 與顯示偏好都會刪除，無法復原。請先匯出備份。',
                      )
                    )
                      return;
                    setDataBusy(true);
                    try {
                      await clearWorks();
                      saveKey('');
                      resetPreferences();
                      localStorage.removeItem(HOME_TOUR_KEY);
                      clearDraftDefaults();
                      localStorage.removeItem('img-generator.chat-models');
                      setApiKey('');
                      setGuestMode(false);
                      setPreferences(readPreferences());
                      const homeState: NavigationState = { studio: true, screen: 'home' };
                      history.replaceState(homeState, '');
                      applyNavigation(homeState);
                      notify('已重設這台裝置。');
                    } catch {
                      notify('重設未完成，請稍後再試。');
                    } finally {
                      setDataBusy(false);
                    }
                  }}
                >
                  清除資料並重設服務
                </button>
                <p className="hint">
                  {loading
                    ? databaseUpgradeBlocked
                      ? '另一個種子畫廊頁面仍在使用本機資料。關閉該頁面後才能安全重設。'
                      : '本機資料仍在載入，完成後才能重設。'
                    : '一併移除作品、API Key 與偏好。無法復原，請先備份。'}
                </p>
              </div>
            </details>
            <div className="studio-credit">
              Made by{' '}
              <a href={STUDIO} target="_blank" rel="noreferrer">
                weiweistudio.com <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </Modal>
      )}
      {enteredStudio && referenceId && (
        <Modal title="參考照片" fullscreen close={() => closeOverlay('fullscreen')}>
          <div className="viewer-image">
            <LocalImage id={referenceId} alt="上傳的參考照片" />
          </div>
        </Modal>
      )}
      {enteredStudio && imageJob?.mediaId && (
        <Modal
          title={models[imageJob.model].name}
          notice={toast}
          wide
          fullscreen={fullscreen}
          close={() => closeOverlay(fullscreen ? 'fullscreen' : 'viewer')}
        >
          <div className="viewer-image">
            <LocalImage
              id={imageJob.mediaId}
              alt={imageJob.draft.prompt}
              controls
              onDimensions={setActualSize}
            />
            {!fullscreen && !isVideo(imageJob.draft) && (
              <button
                className="expand-image"
                aria-label="滿版檢視圖片"
                onClick={() =>
                  navigate({ screen, workId, workTab, overlay: 'fullscreen', jobId: imageJob.id })
                }
              >
                <Maximize2 size={19} />
                放大
              </button>
            )}
          </div>
          <div className="viewer-info">
            <p>{imageJob.draft.prompt}</p>
            <small>
              {date(imageJob.createdAt)} ·{' '}
              {isVideo(imageJob.draft)
                ? `${imageJob.draft.duration ?? 4} 秒 · ${videoResolutionFor(imageJob.model, imageJob.draft)} · ${videoAudioFor(imageJob.model, imageJob.draft) ? '生成聲音' : '無聲'}（請求設定）`
                : actualSize
                  ? `${actualSize.width} × ${actualSize.height} px`
                  : '正在讀取圖片尺寸…'}
            </small>
            {preferences.showMoney && (
              <p className="hint">
                實際費用：{imageJob.cost !== undefined ? money(imageJob.cost) : '服務商未提供'}
              </p>
            )}
            <div className="viewer-actions">
              <button
                className="primary full"
                onClick={async () => {
                  try {
                    const media = await getMedia(imageJob.mediaId!);
                    if (!media) throw new Error();
                    download(media.blob, media.name);
                    notify('已開始下載。iPhone 可在下載項目開啟，再儲存至「照片」。');
                  } catch {
                    notify('作品無法下載，請稍後再試。');
                  }
                }}
              >
                <ArrowDownToLine size={18} />
                {isVideo(imageJob.draft) ? '下載影片' : '下載圖片'}
              </button>
              {!isVideo(imageJob.draft) && (
                <>
                  <button
                    className="secondary full"
                    onClick={() => void createWork(imageJob.mediaId)}
                  >
                    <ImagePlus size={18} />
                    用這張圖開始新作品
                  </button>
                  <button
                    className="secondary full"
                    onClick={() => void createWork(imageJob.mediaId, 'video')}
                  >
                    <Film size={18} />
                    用這張圖製作影片
                  </button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
