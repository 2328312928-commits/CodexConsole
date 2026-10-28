import { useState, type FormEvent } from 'react';
import type { PendingQuestion, QuestionAnswer, UserInputQuestion } from '../../../../shared/api.js';
import { post } from '../../api';
import { CopyButton, ErrorAlert } from '../../components/ui';
import { fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';

const OTHER = '\u0000other';

function useAnswer(questionId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (answer: QuestionAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/questions/${questionId}`, answer);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return { busy, error, send };
}

function InputField({ q, value, other, onValue, onOther }: { q: UserInputQuestion; value: string; other: string; onValue: (v: string) => void; onOther: (v: string) => void }) {
  const { t } = useI18n();
  const id = `q-${q.id}`;
  if (!q.options || q.options.length === 0) {
    return (
      <div className="field">
        <label htmlFor={id}>{q.question}</label>
        <input id={id} type={q.isSecret ? 'password' : 'text'} autoComplete="off" value={value} onChange={(e) => onValue(e.target.value)} />
        {q.isSecret ? <span className="hint">{t('question.secretHint')}</span> : null}
      </div>
    );
  }
  return (
    <fieldset className="field">
      <legend>{q.question}</legend>
      {q.options.map((o) => (
        <label key={o.label} className="checkbox option">
          <input type="radio" name={id} checked={value === o.label} onChange={() => onValue(o.label)} />
          <span>
            {o.label}
            {o.description ? <small className="muted"> — {o.description}</small> : null}
          </span>
        </label>
      ))}
      {q.isOther ? (
        <label className="checkbox option">
          <input type="radio" name={id} checked={value === OTHER} onChange={() => onValue(OTHER)} />
          <span>{t('question.other')}</span>
        </label>
      ) : null}
      {value === OTHER ? (
        <input aria-label={t('question.other')} type={q.isSecret ? 'password' : 'text'} value={other} onChange={(e) => onOther(e.target.value)} autoFocus />
      ) : null}
    </fieldset>
  );
}

function InputQuestions({ question }: { question: PendingQuestion }) {
  const { t } = useI18n();
  const { busy, error, send } = useAnswer(question.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const qs = question.questions ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const answers: Record<string, string[]> = {};
    for (const q of qs) {
      const v = values[q.id] === OTHER ? (others[q.id] ?? '').trim() : (values[q.id] ?? '').trim();
      if (v) answers[q.id] = [v];
    }
    void send({ kind: 'input', answers });
  };
  return (
    <form onSubmit={submit}>
      {qs.map((q) => (
        <div key={q.id}>
          {q.header ? <div className="q-header">{q.header}</div> : null}
          <InputField
            q={q}
            value={values[q.id] ?? ''}
            other={others[q.id] ?? ''}
            onValue={(v) => setValues((p) => ({ ...p, [q.id]: v }))}
            onOther={(v) => setOthers((p) => ({ ...p, [q.id]: v }))}
          />
        </div>
      ))}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          {t('question.answer')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void send({ kind: 'input', answers: {} })}>
          {t('question.skip')}
        </button>
      </div>
      <ErrorAlert error={error} />
    </form>
  );
}

interface SchemaProp {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  default?: unknown;
  format?: string;
}

function schemaFields(schema: unknown): Array<[string, SchemaProp, boolean]> {
  const s = schema as { properties?: Record<string, SchemaProp>; required?: string[] } | null;
  if (!s || typeof s !== 'object' || !s.properties) return [];
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([k, v]) => [k, v ?? {}, required.has(k)]);
}

function initialContent(fields: Array<[string, SchemaProp, boolean]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of fields) {
    if (p.default !== undefined) out[k] = p.default;
    else if (p.type === 'boolean') out[k] = false;
  }
  return out;
}

function Elicitation({ question }: { question: PendingQuestion }) {
  const { t } = useI18n();
  const { busy, error, send } = useAnswer(question.id);
  const fields = schemaFields(question.schema);
  const [content, setContent] = useState<Record<string, unknown>>(() => initialContent(fields));
  const set = (k: string, v: unknown) => setContent((p) => ({ ...p, [k]: v }));
  const safeUrl = question.url && /^https?:\/\//i.test(question.url) ? question.url : null;
  const buttons = (acceptLabel: string) => (
    <div className="row">
      <button type="submit" className="btn primary" disabled={busy}>
        {acceptLabel}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => void send({ kind: 'elicitation', action: 'decline' })}>
        {t('question.decline')}
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void send({ kind: 'elicitation', action: 'cancel' })}>
        {t('common.cancel')}
      </button>
    </div>
  );
  if (question.mode === 'url') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send({ kind: 'elicitation', action: 'accept' });
        }}
      >
        <p className="muted" style={{ margin: '0 0 6px' }}>
          {t('question.urlBody')}
        </p>
        {question.url ? (
          <div className="row" style={{ marginBottom: 10 }}>
            <code className="url-box">{question.url}</code>
            <CopyButton text={question.url} />
            {safeUrl ? (
              <a className="btn small" href={safeUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="link" size={15} />
                {t('question.openLink')}
              </a>
            ) : null}
          </div>
        ) : null}
        {buttons(t('question.urlDone'))}
        <ErrorAlert error={error} />
      </form>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send({ kind: 'elicitation', action: 'accept', content });
      }}
    >
      {fields.map(([k, p, required]) => {
        const id = `el-${question.id}-${k}`;
        const label = p.title || k;
        if (p.type === 'boolean') {
          return (
            <label key={k} className="checkbox" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={Boolean(content[k])} onChange={(e) => set(k, e.target.checked)} />
              <span>
                {label}
                {p.description ? <small className="muted"> — {p.description}</small> : null}
              </span>
            </label>
          );
        }
        return (
          <div className="field" key={k}>
            <label htmlFor={id}>{label}</label>
            {Array.isArray(p.enum) ? (
              <select id={id} value={String(content[k] ?? '')} required={required} onChange={(e) => set(k, e.target.value)}>
                <option value="">{t('question.choose')}</option>
                {p.enum.map((v, i) => (
                  <option key={String(v)} value={String(v)}>
                    {p.enumNames?.[i] ?? String(v)}
                  </option>
                ))}
              </select>
            ) : p.type === 'number' || p.type === 'integer' ? (
              <input
                id={id}
                type="number"
                step={p.type === 'integer' ? 1 : 'any'}
                required={required}
                value={content[k] === undefined ? '' : String(content[k])}
                onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            ) : (
              <input
                id={id}
                type={p.format === 'email' ? 'email' : p.format === 'uri' ? 'url' : p.format === 'date' ? 'date' : 'text'}
                required={required}
                value={String(content[k] ?? '')}
                onChange={(e) => set(k, e.target.value)}
              />
            )}
            {p.description ? <span className="hint">{p.description}</span> : null}
          </div>
        );
      })}
      {buttons(t('question.submit'))}
      <ErrorAlert error={error} />
    </form>
  );
}

/** Codex (or an MCP server through Codex) waiting for an answer. */
export function QuestionCard({ question }: { question: PendingQuestion }) {
  const { t, lang } = useI18n();
  const title = question.kind === 'input' ? t('question.title') : t('question.elicitationTitle', { server: question.server ?? '?' });
  return (
    <div className="approval question" role="group" aria-label={title}>
      <h3>
        <Icon name="help" size={16} />
        {title}
      </h3>
      {question.message ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{question.message}</p> : null}
      {question.kind === 'input' ? <InputQuestions question={question} /> : <Elicitation question={question} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {t('question.expires', { time: fmtRelative(lang, t, question.expiresAt) })}
      </div>
    </div>
  );
}

/** Transcript line for a question that was answered, declined or timed out. */
export function QuestionLog({ data }: { data: { kind: string; server: string | null; questions: Array<{ id: string; question: string }> | null; answers: Record<string, string[]> | null; action: string | null; outcome: string } }) {
  const { t } = useI18n();
  const label =
    data.outcome === 'timeout'
      ? t('question.log.timeout')
      : data.kind === 'input'
        ? Object.keys(data.answers ?? {}).length > 0
          ? t('question.log.answered')
          : t('question.log.skipped')
        : data.action === 'accept'
          ? t('question.log.accepted', { server: data.server ?? '?' })
          : data.action === 'cancel'
            ? t('question.log.cancelled', { server: data.server ?? '?' })
            : t('question.log.declined', { server: data.server ?? '?' });
  const answered = (data.questions ?? []).filter((q) => data.answers?.[q.id]?.length);
  return (
    <div className="approval-log">
      <Icon name="help" size={14} />
      <span>{label}</span>
      {answered.map((q) => (
        <span key={q.id} className="muted">
          {q.question}: <strong>{data.answers![q.id]!.join(', ')}</strong>
        </span>
      ))}
    </div>
  );
}
