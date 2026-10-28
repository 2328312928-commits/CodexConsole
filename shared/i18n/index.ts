import { en, type MessageKey } from './en.js';
import { zhCN } from './zh-CN.js';

export type { MessageKey } from './en.js';
export type Lang = 'en' | 'zh-CN';
export const LANGS: readonly Lang[] = ['en', 'zh-CN'];

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

export type Vars = Record<string, string | number>;

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const template = DICTS[lang][key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function isMessageKey(key: string): key is MessageKey {
  return key in en;
}

/** Pick a supported language from preference strings such as navigator.languages or $LANG. */
export function detectLang(candidates: ReadonlyArray<string | undefined>): Lang {
  for (const c of candidates) {
    if (!c) continue;
    const l = c.toLowerCase();
    if (l.startsWith('zh')) return 'zh-CN';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

export function dictionary(lang: Lang): Record<MessageKey, string> {
  return DICTS[lang];
}
