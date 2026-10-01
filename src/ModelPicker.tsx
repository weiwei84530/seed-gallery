import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { models } from './models';
import type { ModelId } from './types';
import type { ModelEstimate } from './pricing';
import googleLogo from './assets/providers/gemini.svg';
import openaiLogo from './assets/providers/openai.svg';
import bflLogo from './assets/providers/bfl.svg';
import bytedanceLogo from './assets/providers/bytedance.svg';
import klingLogo from './assets/providers/kling.svg';
import minimaxLogo from './assets/providers/minimax.svg';
import wanLogo from './assets/providers/wan.png';
import grokLogo from './assets/providers/grok.svg';
import metaLogo from './assets/providers/meta.svg';

const providerLogos = {
  grok: grokLogo,
  muse: metaLogo,
  banana: googleLogo,
  gpt: openaiLogo,
  gptFlare: openaiLogo,
  gptSunburst: openaiLogo,
  flux: bflLogo,
  seedream: bytedanceLogo,
  kling: klingLogo,
  seedance: bytedanceLogo,
  seedance25: bytedanceLogo,
  omni: googleLogo,
  wan: wanLogo,
  minimax: minimaxLogo,
  veo: googleLogo,
};

export function ProviderLogo({ model }: { model: ModelId }) {
  return (
    <span className={`model-icon ${model}`}>
      {providerLogos[model] ? (
        <img src={providerLogos[model]} alt="" />
      ) : (
        <span aria-hidden="true">{models[model].letter}</span>
      )}
    </span>
  );
}

function ModelContents({
  model,
  estimate,
  showMoney,
}: {
  model: ModelId;
  estimate?: ModelEstimate;
  showMoney?: boolean;
}) {
  return (
    <>
      <ProviderLogo model={model} />
      <span className="model-option-copy">
        <strong>{models[model].name}</strong>
        <small>{models[model].note}</small>
        {showMoney && (
          <small className="model-price">
            {!estimate
              ? '正在查詢價格…'
              : estimate.amount === null
                ? estimate.reason
                : `預估 US$ ${estimate.amount.toFixed(4).replace(/0{1,2}$/, '')}／${models[model].kind === 'video' ? '支' : '張'}`}
          </small>
        )}
      </span>
    </>
  );
}

export function ModelPicker({
  selected,
  available,
  onChange,
  estimates,
  showMoney,
}: {
  selected: ModelId[];
  available: ModelId[];
  onChange: (models: ModelId[]) => void;
  estimates?: Partial<Record<ModelId, ModelEstimate>>;
  showMoney?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const focusTarget = useRef<number | null>(null);
  const focusOption = useRef(false);
  const id = useId();
  const choices = available.filter((model) => !selected.includes(model));

  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  useLayoutEffect(() => {
    if (focusTarget.current !== null) {
      triggers.current.get(focusTarget.current)?.focus();
      focusTarget.current = null;
    }
    if (open !== null && focusOption.current) {
      root.current?.querySelector<HTMLButtonElement>('[data-open="true"] .model-option')?.focus();
      focusOption.current = false;
    }
  }, [selected, open]);

  const close = () => {
    if (open !== null) triggers.current.get(open)?.focus();
    setOpen(null);
  };

  return (
    <div
      className="model-list"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open !== null) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {[...selected, ...(choices.length ? [null] : [])].map((model, index) => {
        const expanded = open === index;
        const panelId = `${id}-options-${index}`;
        return (
          <div
            className={`model-select${model === null ? ' model-select-add' : ''}`}
            data-open={expanded}
            key={index}
          >
            <div className="model-select-heading">
              <button
                type="button"
                className={model === null ? 'add-model-row' : 'model-card model-trigger'}
                ref={(element) => {
                  if (element) triggers.current.set(index, element);
                  else triggers.current.delete(index);
                }}
                aria-label={
                  model === null
                    ? expanded
                      ? '取消新增模型'
                      : '新增模型'
                    : `替換 ${models[model].name}`
                }
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setOpen(expanded ? null : index)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    if (expanded) {
                      event.currentTarget
                        .closest('.model-select')
                        ?.querySelector<HTMLButtonElement>('.model-option')
                        ?.focus();
                    } else {
                      focusOption.current = true;
                      setOpen(index);
                    }
                  }
                }}
              >
                {model === null ? (
                  <span>{expanded ? '選擇要加入的 AI' : '新增模型'}</span>
                ) : (
                  <ModelContents
                    model={model}
                    estimate={estimates?.[model]}
                    showMoney={showMoney}
                  />
                )}
                {model === null && !expanded ? <Plus size={20} aria-hidden="true" /> : null}
              </button>
              {model !== null && (
                <button
                  type="button"
                  className="icon-button model-remove"
                  aria-label={`移除 ${models[model].name}`}
                  onClick={() => {
                    focusTarget.current = Math.min(index, selected.length - 1);
                    setOpen(null);
                    onChange(selected.filter((_, position) => position !== index));
                  }}
                >
                  <Minus size={20} />
                </button>
              )}
            </div>
            <div id={panelId} className="model-options" inert={!expanded} aria-hidden={!expanded}>
              <div className="model-options-inner">
                {choices.map((choice) => (
                  <button
                    type="button"
                    className="model-card model-option"
                    key={choice}
                    aria-label={`${model === null ? '新增' : '改用'} ${models[choice].name}`}
                    onClick={() => {
                      focusTarget.current = index;
                      setOpen(null);
                      onChange(
                        model === null
                          ? [...selected, choice]
                          : selected.map((value, position) =>
                              position === index ? choice : value,
                            ),
                      );
                    }}
                    onKeyDown={(event) => {
                      const buttons = Array.from(
                        event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                          'button',
                        ),
                      );
                      const position = buttons.indexOf(event.currentTarget);
                      const next =
                        event.key === 'ArrowDown'
                          ? (position + 1) % buttons.length
                          : event.key === 'ArrowUp'
                            ? (position + buttons.length - 1) % buttons.length
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? buttons.length - 1
                                : null;
                      if (next !== null) {
                        event.preventDefault();
                        buttons[next].focus();
                      }
                    }}
                  >
                    <ModelContents
                      model={choice}
                      estimate={estimates?.[choice]}
                      showMoney={showMoney}
                    />
                    {model === null && <Plus size={18} aria-hidden="true" />}
                  </button>
                ))}
                {!choices.length && (
                  <p className="model-options-empty">所有模型都已選取，可先移除其他模型再替換。</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
