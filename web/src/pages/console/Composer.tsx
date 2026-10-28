import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { EffectiveSettings, ModelInfo, QueuedPrompt, SavedPrompt, SessionInfo, SessionSettings, SkillInfo } from '../../../../shared/api.js';
import { uploadFiles } from '../../api';
import { Menu } from '../../components/Menu';
import { ErrorAlert } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { ModelPicker } from './ModelPicker';
import { CLIENT_COMMANDS, COMPOSER_COMMANDS, commandKey, ImageUrlDialog, MentionDialog, SkillsDialog, type ClientCommand } from './SessionTools';

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
  effective,
  running,
  disabledReason,
  attachments,
  setAttachments,
  queue,
  savedPrompts,
  onSend,
  onQueue,
  onCommand,
  onSteer,
  onStop,
  onSettings,
  onTool,
  onClientCommand,
  onRemoveQueued,
  onResumeQueue,
}: {
  session: SessionInfo;
  models: ModelInfo[];
  effective: EffectiveSettings | null;
  running: boolean;
  disabledReason: string | null;
  attachments: Attachment[];
  setAttachments: (next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;
  queue: { queue: QueuedPrompt[]; paused: boolean };
  savedPrompts: SavedPrompt[];
  onSend: (text: string, extras: PromptExtras) => Promise<void>;
  onQueue: (text: string, extras: PromptExtras) => Promise<void>;
  onCommand: (text: string) => Promise<void>;
  onSteer: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  onTool: (tool: ToolDialog) => void;
  onClientCommand: (cmd: ClientCommand) => void;
  onRemoveQueued: (id: string) => Promise<void>;
  onResumeQueue: () => Promise<void>;
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
  const [dragging, setDragging] = useState(false);
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

  const canAttach = session.workspacePath !== null;
  const trimmed = text.trim();
  const isCommand = trimmed.startsWith('/') || trimmed.startsWith('!');
  const hasExtras = attachments.length + mentions.length + skills.length + imageUrls.length > 0;
  const planMode = session.settings.mode === 'plan';

  // Slash-command menu, including saved prompts as `/prompts:<name>`.
  const allCommands = useMemo(() => [...COMPOSER_COMMANDS, ...savedPrompts.map((p) => `/prompts:${p.name}`)], [savedPrompts]);
  const matches = useMemo(() => {
    if (menuDismissed || !/^[/!][a-z:_-]*$/i.test(text)) return [];
    return allCommands.filter((c) => c.startsWith(text) || (text === '!' && c === '!'));
  }, [text, menuDismissed, allCommands]);
  useEffect(() => setMenuIndex(0), [matches.length]);
  useEffect(() => {
    menuList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [menuIndex]);
  useEffect(() => setMenuDismissed(false), [text === '']); // eslint-disable-line react-hooks/exhaustive-deps

  const describe = (c: string) => {
    if (c.startsWith('/prompts:')) return savedPrompts.find((p) => `/prompts:${p.name}` === c)?.description || t('cmd.prompts');
    return t(commandKey(c));
  };

  const pickCommand = (name: string) => {
    if (name.startsWith('/prompts:')) {
      const p = savedPrompts.find((x) => `/prompts:${x.name}` === name);
      setText(p ? p.content.trim() : '');
      textarea.current?.focus();
      return;
    }
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
    if ((CLIENT_COMMANDS as readonly string[]).includes(name)) {
      setText('');
      onClientCommand(name as ClientCommand);
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

  const extras = (): PromptExtras => ({ mentions: mentions.map((m) => m.path), skills: skills.map((s) => s.name), imageUrls });
  const clearAll = () => {
    setText('');
    setMentions([]);
    setSkills([]);
    setImageUrls([]);
  };

  const submit = async (mode: 'send' | 'steer' = 'send') => {
    if (busy) return;
    if (isCommand) {
      const name = trimmed.split(/\s/, 1)[0]!;
      if ((CLIENT_COMMANDS as readonly string[]).includes(name) && trimmed === name) {
        setText('');
        onClientCommand(name as ClientCommand);
        return;
      }
      if (trimmed.length > 1) await run(() => onCommand(trimmed), () => setText(''));
      return;
    }
    if (disabledReason) return;
    if (!trimmed && !hasExtras) return;
    if (running && mode === 'steer') {
      if (trimmed) await run(() => onSteer(trimmed), () => setText(''));
      return;
    }
    if (running) {
      await run(() => onQueue(text, extras()), clearAll);
      return;
    }
    await run(() => onSend(text, extras()), clearAll);
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
      void submit(e.shiftKey ? 'steer' : 'send');
    }
  };

  const upload = async (files: File[]) => {
    if (files.length === 0 || session.workspacePath === null) return;
    setError(null);
    const dir = session.workspacePath ? `${session.workspacePath}/uploads` : 'uploads';
    for (const file of files) {
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

  // Paste screenshots straight into the prompt.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || !canAttach) return;
    e.preventDefault();
    const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
    void upload(named);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files.length || !canAttach) return;
    e.preventDefault();
    setDragging(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  const sendLabel = isCommand ? t('composer.run') : running ? t('composer.queue') : t('composer.send');
  const sendDisabled = busy || (isCommand ? trimmed.length < 2 : Boolean(disabledReason) || (!trimmed && !hasExtras));

  return (
    <div className="composer">
      <div className="composer-inner">
        {queue.queue.length > 0 ? (
          <div className="queue-list" aria-label={t('queue.title')}>
            <div className="queue-head">
              <Icon name="layers" size={14} />
              <span>{queue.paused ? t('queue.paused') : t('queue.title')}</span>
              {queue.paused && !running ? (
                <button type="button" className="btn small" onClick={() => void onResumeQueue().catch(setError)}>
                  <Icon name="play" size={13} />
                  {t('queue.resume')}
                </button>
              ) : null}
            </div>
            {queue.queue.map((q) => (
              <div className="queue-item" key={q.id}>
                <span className="clip-text">{q.text || t('queue.attachmentsOnly')}</span>
                <button type="button" className="btn ghost icon small" onClick={() => void onRemoveQueued(q.id).catch(setError)} aria-label={t('queue.remove')} title={t('queue.remove')}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {disabledReason ? (
          <div className="alert warn">
            <Icon name="alert" />
            {disabledReason}
          </div>
        ) : null}
        <div
          className={`composer-card ${dragging ? 'dragging' : ''} ${planMode ? 'plan' : ''}`}
          onDragOver={(e) => {
            if (canAttach && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
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
            <div className="progress" title={t('composer.uploading', { name: uploading.name })}>
              <div style={{ width: `${Math.round(uploading.progress * 100)}%` }} />
            </div>
          ) : null}
          <div className="composer-field">
            {matches.length > 0 ? (
              <ul className="cmd-menu" role="listbox" aria-label={t('commands.title')} ref={menuList}>
                {matches.map((c, i) => (
                  <li key={c} role="option" aria-selected={i === menuIndex}>
                    <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pickCommand(c)} onMouseEnter={() => setMenuIndex(i)}>
                      <span className="mono">{c}</span>
                      <span className="muted">{describe(c)}</span>
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
              onPaste={onPaste}
              placeholder={running ? t('composer.steerPlaceholder') : t('composer.placeholder')}
              rows={2}
              aria-autocomplete="list"
              aria-expanded={matches.length > 0}
            />
          </div>
          <div className="composer-bar">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
            <button type="button" className="btn ghost icon small" onClick={() => fileInput.current?.click()} disabled={!canAttach || Boolean(uploading)} title={canAttach ? t('composer.attach') : t('files.unavailable')} aria-label={t('composer.attach')}>
              <Icon name="clip" size={16} />
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
            <span className="bar-sep" />
            <ModelPicker models={models} settings={session.settings} effective={effective} onChange={(p) => void onSettings(p).catch(setError)} />
            <button
              type="button"
              className={`chip-btn plan-toggle ${planMode ? 'on' : ''}`}
              aria-pressed={planMode}
              title={t('composer.planHint')}
              onClick={() => void onSettings({ mode: planMode ? 'default' : 'plan' }).catch(setError)}
            >
              <Icon name="listCheck" size={14} />
              {t('composer.plan')}
            </button>
            <span className="spacer" />
            {running ? (
              <>
                <button type="button" className="btn ghost small" onClick={() => void submit('steer')} disabled={busy || !trimmed || isCommand} title={t('composer.steerHint')}>
                  <Icon name="steer" size={14} />
                  {t('composer.steer')}
                </button>
                <button type="button" className="btn small danger stop-btn" onClick={() => void onStop().catch(setError)} aria-label={t('composer.stop')} title={t('composer.stop')}>
                  <Icon name="stop" size={14} />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={`send-btn ${running && !isCommand ? 'queue' : ''}`}
              onClick={() => void submit('send')}
              disabled={sendDisabled}
              aria-label={sendLabel}
              title={`${sendLabel} (Ctrl+Enter)`}
            >
              <Icon name={isCommand ? 'terminal' : running ? 'layers' : 'arrowUp'} size={17} />
            </button>
          </div>
        </div>
        <ErrorAlert error={error} />
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
