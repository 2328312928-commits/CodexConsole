import type { EffectiveSettings, ModelInfo, ReasoningSummary, SessionSettings } from '../../../../shared/api.js';
import type { MessageKey } from '../../../../shared/i18n/index.js';
import { Popover } from '../../components/Popover';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';

const EFFORT_KEYS: Record<string, MessageKey> = {
  none: 'effort.none',
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  ultra: 'effort.ultra',
};
const SUMMARIES: Array<ReasoningSummary | null> = [null, 'concise', 'detailed', 'none'];
const SUMMARY_KEYS: Record<string, MessageKey> = { auto: 'summary.auto', concise: 'summary.concise', detailed: 'summary.detailed', none: 'summary.none' };

export function effortLabel(t: (k: MessageKey) => string, effort: string): string {
  return EFFORT_KEYS[effort] ? t(EFFORT_KEYS[effort]!) : effort;
}

/**
 * Model, reasoning level, speed and reasoning-summary detail for the next turn, from the options
 * Codex itself offers for each model. The choice is kept for the session.
 */
export function ModelPicker({
  models,
  settings,
  effective,
  onChange,
  disabled,
}: {
  models: ModelInfo[];
  settings: SessionSettings;
  effective: EffectiveSettings | null;
  onChange: (patch: Partial<SessionSettings>) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const defaultModel = models.find((m) => m.isDefault) ?? models[0];
  const current = models.find((m) => m.id === (settings.model ?? effective?.model)) ?? defaultModel;
  if (!current) return null;
  const effort = settings.effort && current.efforts.includes(settings.effort) ? settings.effort : null;
  const shownEffort = effort ?? (effective?.model === current.id ? effective?.effort : null) ?? current.defaultEffort;
  const fast = settings.serviceTier !== null && current.serviceTiers.some((x) => x.id === settings.serviceTier);
  const summary = settings.summary;
  const trigger = (
    <>
      <span className="picker-model">{current.displayName}</span>
      {shownEffort ? <span className="picker-effort">{effortLabel(t, shownEffort)}</span> : null}
      {fast ? <Icon name="bolt" size={13} className="picker-fast" /> : null}
      <Icon name="chevronDown" size={13} />
    </>
  );
  return (
    <Popover trigger={trigger} label={t('picker.label')} className={`picker ${disabled ? 'disabled' : ''}`} placement="top">
      {(close) => (
        <div className="picker-body">
          <div className="picker-section">{t('picker.model')}</div>
          <ul className="picker-models" role="listbox" aria-label={t('picker.model')}>
            {models.map((m) => {
              const selected = m.id === current.id && (settings.model !== null || m.isDefault);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange({ model: m.isDefault ? null : m.id, effort: null, serviceTier: m.serviceTiers.some((x) => x.id === settings.serviceTier) ? settings.serviceTier : null });
                      close();
                    }}
                  >
                    <span className="picker-row">
                      <span className="picker-name">{m.displayName}</span>
                      {m.inputModalities.includes('image') ? <Icon name="image" size={13} className="muted" aria-hidden /> : null}
                      {selected ? <Icon name="check" size={15} className="picker-check" /> : null}
                    </span>
                    {m.description ? <span className="picker-desc">{m.description}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {current.effortOptions.length > 0 ? (
            <>
              <div className="picker-section">{t('picker.reasoning')}</div>
              <div className="seg-ctl wrap" role="radiogroup" aria-label={t('picker.reasoning')}>
                {current.effortOptions.map((o) => (
                  <button
                    key={o.effort}
                    type="button"
                    role="radio"
                    aria-checked={shownEffort === o.effort}
                    title={o.description || undefined}
                    onClick={() => onChange({ effort: o.effort === current.defaultEffort && !settings.effort ? null : o.effort })}
                  >
                    {effortLabel(t, o.effort)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {current.serviceTiers.length > 0 ? (
            <>
              <div className="picker-section">{t('picker.speed')}</div>
              <div className="seg-ctl" role="radiogroup" aria-label={t('picker.speed')}>
                <button type="button" role="radio" aria-checked={!fast} onClick={() => onChange({ serviceTier: null })}>
                  {t('picker.standard')}
                </button>
                {current.serviceTiers.map((tier) => (
                  <button key={tier.id} type="button" role="radio" aria-checked={settings.serviceTier === tier.id} title={tier.description || undefined} onClick={() => onChange({ serviceTier: tier.id })}>
                    <Icon name="bolt" size={13} />
                    {tier.name}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="picker-section">{t('picker.summary')}</div>
          <div className="seg-ctl" role="radiogroup" aria-label={t('picker.summary')}>
            {SUMMARIES.map((v) => (
              <button key={v ?? 'auto'} type="button" role="radio" aria-checked={summary === v} onClick={() => onChange({ summary: v })}>
                {t(SUMMARY_KEYS[v ?? 'auto']!)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
