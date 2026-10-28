import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelInfo, SessionInfo, SessionSettings, SkillInfo } from '../../../../shared/api.js';
import { uploadFiles } from '../../api';
import { Menu } from '../../components/Menu';
import { ErrorAlert } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { COMPOSER_COMMANDS, commandKey, ImageUrlDialog, MentionDialog, SkillsDialog } from './SessionTools';

export interface Attachment {
  path: string;
  name: string;
  size: number;
}

export interface PromptExtras {
  mentions: string[];
  skills: string[];
  imageUrls: string[];
}

/** Commands that open a dialog instead of being sent as text. */
export type ToolDialog = 'settings' | 'review' | 'goal' | 'status' | 'diff';
const DIALOG_COMMANDS: Record<string, ToolDialog> = {
  '/model': 'settings',
  '/approvals': 'settings',
  '/sandbox': 'settings',
  '/network': 'settings',
  '/review': 'review',
  '/goal': 'goal',
  '/status': 'status',
  '/diff': 'diff',
};

export function Composer({
  session,
  models,
  running,
  disabledReason,
  attachments,
  setAttachments,
  onSend,
  onCommand,
  onSteer,
  onStop,
  onSettings,
  onTool,
}: {
  session: SessionInfo;
  models: ModelInfo[];
  running: boolean;
  disabledReason: string | null;
  attachments: Attachment[];
  setAttachments: (next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;
  onSend: (text: string, extras: PromptExtras) => Promise<void>;
  onCommand: (text: string) => Promise<void>;
  onSteer: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  onTool: (tool: ToolDialog) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Array<{ path: string; name: string }>>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'mention' | 'skills' | 'imageUrl' | null>(null);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const menuList = useRef<HTMLUListElement>(null);
  const draftKey = `cc.draft.${session.id}`;

  useEffect(() => {
    try {
      setText(sessionStorage.getItem(draftKey) ?? '');
    } catch {
      setText('');
    }
    setMentions([]);
    setSkills([]);
    setImageUrls([]);
    setError(null);
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {
      // storage unavailable
    }
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    }
  }, [text, draftKey]);

  const model = session.settings.model;
  const effort = session.settings.effort;
  const selectedModel = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? null;
  const efforts = selectedModel?.efforts ?? [];
  const canAttach = session.workspacePath !== null;
  const trimmed = text.trim();
  const isCommand = trimmed.startsWith('/') || trimmed.startsWith('!');
  const hasExtras = attachments.length + mentions.length + skills.length + imageUrls.length > 0;

  // Slash-command menu: shown while the first word is being typed.
  const matches = useMemo(() => {
    if (menuDismissed || !/^[/!][a-z]*$/.test(text)) return [];
    return COMPOSER_COMMANDS.filter((c) => c.startsWith(text) || (text === '!' && c === '!'));
  }, [text, menuDismissed]);
  useEffect(() => setMenuIndex(0), [matches.length]);
  useEffect(() => {
    menuList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [menuIndex]);
  useEffect(() => setMenuDismissed(false), [text === '']); // eslint-disable-line react-hooks/exhaustive-deps

  const pickCommand = (name: string) => {
    const tool = DIALOG_COMMANDS[name];
    if (tool) {
      setText('');
      onTool(tool);
      return;
    }
    if (name === '/mention') {
      setText('');
      setDialog('mention');
      return;
    }
    if (name === '/skills') {
      setText('');
      setDialog('skills');
      return;
    }
    setText(name === '!' ? '!' : `${name} `);
    textarea.current?.focus();
  };

  const run = async (fn: () => Promise<void>, clear: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      clear();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (busy) return;
    if (isCommand) {
      if (trimmed.length > 1) await run(() => onCommand(trimmed), () => setText(''));
      return;
    }
    if (disabledReason) return;
    if (running) {
      if (trimmed) await run(() => onSteer(trimmed), () => setText(''));
      return;
    }
    if (!trimmed && !hasExtras) return;
    await run(
      () => onSend(text, { mentions: mentions.map((m) => m.path), skills: skills.map((s) => s.name), imageUrls }),
      () => {
        setText('');
        setMentions([]);
        setSkills([]);
        setImageUrls([]);
      },
    );
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        pickCommand(matches[menuIndex] ?? matches[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0 || session.workspacePath === null) return;
    setError(null);
    const dir = session.workspacePath ? `${session.workspacePath}/uploads` : 'uploads';
    for (const file of Array.from(files)) {
      setUploading({ name: file.name, progress: 0 });
      try {
        const res = await uploadFiles(dir, [file], { session: session.id, onProgress: (p) => setUploading({ name: file.name, progress: p }) });
        setAttachments((prev) => [...prev, ...res.files.map((f) => ({ path: f.path, name: f.name, size: f.size }))]);
      } catch (err) {
        setError(err);
        break;
      }
    }
    setUploading(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const sendLabel = isCommand ? t('composer.run') : running ? t('composer.steer') : t('composer.send');
  const sendDisabled = busy || (isCommand ? trimmed.length < 2 : Boolean(disabledReason) || (running ? !trimmed : !trimmed && !hasExtras));

  return (
    <div className="composer">
      <div className="composer-inner">
        {disabledReason ? (
          <div className="alert warn">
            <Icon name="alert" />
            {disabledReason}
          </div>
        ) : null}
        {hasExtras ? (
          <div className="chips">
            {attachments.map((a) => (
              <span className="chip" key={`a:${a.path}`}>
                <Icon name={/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name) ? 'image' : 'file'} size={14} />
                <span title={a.path}>{a.name}</span>
                <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} aria-label={t('composer.removeAttachment', { name: a.name })}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
            {mentions.map((m) => (
              <span className="chip" key={`m:${m.path}`}>
                <Icon name="at" size={14} />
                <span title={m.path}>{m.name}</span>
                <button type="button" onClick={() => setMentions((prev) => prev.filter((x) => x.path !== m.path))} aria-label={t('composer.removeAttachment', { name: m.name })}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
            {skills.map((s) => (
              <span className="chip" key={`s:${s.name}`}>
                <Icon name="sparkle" size={14} />
                <span title={s.description}>{s.name}</span>
                <button type="button" onClick={() => setSkills((prev) => prev.filter((x) => x.name !== s.name))} aria-label={t('composer.removeAttachment', { name: s.name })}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
            {imageUrls.map((u) => (
              <span className="chip" key={`u:${u}`}>
                <Icon name="link" size={14} />
                <span title={u}>{u.replace(/^https:\/\//, '')}</span>
                <button type="button" onClick={() => setImageUrls((prev) => prev.filter((x) => x !== u))} aria-label={t('composer.removeAttachment', { name: u })}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {uploading ? (
          <div>
            <div className="muted" style={{ fontSize: 12 }}>
              {t('composer.uploading', { name: uploading.name })}
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round(uploading.progress * 100)}%` }} />
            </div>
          </div>
        ) : null}
        <div className="composer-field">
          {matches.length > 0 ? (
            <ul className="cmd-menu" role="listbox" aria-label={t('commands.title')} ref={menuList}>
              {matches.map((c, i) => (
                <li key={c} role="option" aria-selected={i === menuIndex}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCommand(c)}
                    onMouseEnter={() => setMenuIndex(i)}
                  >
                    <span className="mono">{c}</span>
                    <span className="muted">{t(commandKey(c))}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="sr-only" htmlFor="composer-text">
            {running ? t('composer.steerPlaceholder') : t('composer.placeholder')}
          </label>
          <textarea
            id="composer-text"
            ref={textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={running ? t('composer.steerPlaceholder') : t('composer.placeholder')}
            rows={3}
            aria-autocomplete="list"
            aria-expanded={matches.length > 0}
          />
        </div>
        <ErrorAlert error={error} />
        <div className="composer-bar">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <button type="button" className="btn small" onClick={() => fileInput.current?.click()} disabled={!canAttach || Boolean(uploading)} title={canAttach ? undefined : t('files.unavailable')}>
            <Icon name="clip" size={15} />
            <span className="hide-mobile">{t('composer.attach')}</span>
          </button>
          <Menu
            label={t('composer.addContext')}
            icon="plus"
            items={[
              { label: t('composer.mentionFile'), icon: 'at', onSelect: () => setDialog('mention'), disabled: !canAttach },
              { label: t('composer.useSkill'), icon: 'sparkle', onSelect: () => setDialog('skills') },
              { label: t('composer.imageLink'), icon: 'link', onSelect: () => setDialog('imageUrl') },
            ]}
          />
          {models.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="composer-model">
                {t('session.model')}
              </label>
              <select
                id="composer-model"
                value={model ?? ''}
                onChange={(e) => void onSettings({ model: e.target.value || null, effort: null }).catch(setError)}
                title={t('session.model')}
              >
                <option value="">{t('session.defaultModel')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              {efforts.length > 0 ? (
                <>
                  <label className="sr-only" htmlFor="composer-effort">
                    {t('session.effort')}
                  </label>
                  <select id="composer-effort" value={effort ?? ''} onChange={(e) => void onSettings({ effort: e.target.value || null }).catch(setError)} title={t('session.effort')}>
                    <option value="">{t('composer.effortOption', { effort: t('session.defaultModel') })}</option>
                    {efforts.map((x) => (
                      <option key={x} value={x}>
                        {t('composer.effortOption', { effort: x })}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </>
          ) : null}
          <span className="hint hide-mobile">{t('composer.hint')}</span>
          <span className="spacer" />
          {running ? (
            <button type="button" className="btn danger" onClick={() => void onStop().catch(setError)}>
              <Icon name="stop" size={15} />
              {t('composer.stop')}
            </button>
          ) : null}
          <button type="button" className={`btn ${running && !isCommand ? '' : 'primary'}`} onClick={() => void submit()} disabled={sendDisabled}>
            <Icon name={isCommand ? 'terminal' : 'send'} size={15} />
            {sendLabel}
          </button>
        </div>
      </div>
      {dialog === 'mention' ? (
        <MentionDialog sessionId={session.id} onClose={() => setDialog(null)} onPick={(f) => setMentions((prev) => (prev.some((x) => x.path === f.path) ? prev : [...prev, f]))} />
      ) : null}
      {dialog === 'skills' ? (
        <SkillsDialog sessionId={session.id} onClose={() => setDialog(null)} onPick={(s) => setSkills((prev) => (prev.some((x) => x.name === s.name) ? prev : [...prev, s]))} />
      ) : null}
      {dialog === 'imageUrl' ? <ImageUrlDialog onClose={() => setDialog(null)} onAdd={(u) => setImageUrls((prev) => (prev.includes(u) ? prev : [...prev, u]))} /> : null}
    </div>
  );
}
