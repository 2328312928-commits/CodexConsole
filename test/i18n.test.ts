import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../shared/i18n/en.js';
import { zhCN } from '../shared/i18n/zh-CN.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Strings that are legitimately identical in both languages.
const SAME_IN_BOTH = new Set([
  'codex.status',
  'lang.en',
  'lang.zh-CN',
  'turn.codex',
  'turn.duration',
  'turn.unknownItem',
  'requests.ip',
  'devices.transferLine',
  'unit.bytes',
  'unit.kb',
  'unit.mb',
  'unit.gb',
]);

describe('translations', () => {
  it('has a Chinese string for every English key and nothing extra', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it('keeps the same {placeholders} and never leaves a string empty', () => {
    for (const [key, value] of Object.entries(en)) {
      const zh = zhCN[key as keyof typeof en];
      expect(zh.trim(), key).not.toBe('');
      expect(placeholders(zh), key).toEqual(placeholders(value));
    }
  });

  it('actually translates (no English copied into the Chinese dictionary)', () => {
    const untranslated = Object.entries(en)
      .filter(([key, value]) => /[A-Za-z]{3}/.test(value.replace(/\{\w+\}|`[^`]*`|Codex|CSV|TOTP|ChatGPT|API|IP|URL|TLS/g, '')))
      .filter(([key, value]) => !SAME_IN_BOTH.has(key) && zhCN[key as keyof typeof en] === value)
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });
});

// Any visible text in the UI must come from t(...). Catch literals in JSX text and in
// user-facing attributes.
const WEB = fileURLToPath(new URL('../web/src', import.meta.url));
const ALLOWED_LITERALS = new Set(['my-project', 'npm run setup', '中文', 'EN']);

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

const TEXT_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label']);
const HAS_WORDS = /[A-Za-z一-鿿]/;

describe('no hard-coded UI text', () => {
  it('finds no untranslated text in the web sources', () => {
    const problems: string[] = [];
    for (const file of tsxFiles(WEB)) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const report = (node: ts.Node, text: string) => {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        problems.push(`${path.relative(WEB, file)}:${line + 1}: ${text}`);
      };
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.getText().trim();
          if (text && HAS_WORDS.test(text) && !ALLOWED_LITERALS.has(text)) report(node, text);
        } else if (ts.isJsxAttribute(node) && TEXT_ATTRS.has(node.name.getText()) && node.initializer && ts.isStringLiteral(node.initializer)) {
          const text = node.initializer.text;
          if (HAS_WORDS.test(text) && !ALLOWED_LITERALS.has(text)) report(node, `${node.name.getText()}="${text}"`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(problems).toEqual([]);
  });
});
