import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { fileUrl } from './api.js';

marked.setOptions({ gfm: true, breaks: false });

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Join a relative reference onto the session folder, refusing to climb out of it. */
function workspaceRef(base: string | null, ref: string): string | null {
  if (base === null || SCHEME.test(ref) || ref.startsWith('/') || ref.startsWith('#') || ref.startsWith('//')) return null;
  let clean: string;
  try {
    clean = decodeURIComponent(ref.split(/[?#]/)[0]!);
  } catch {
    return null; // malformed escape: not a usable workspace path
  }
  const segs = [...base.split('/').filter(Boolean)];
  for (const s of clean.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else segs.push(s);
  }
  return segs.join('/');
}

let currentBase: string | null = null;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    const rel = workspaceRef(currentBase, href);
    if (rel !== null) node.setAttribute('href', fileUrl(rel, 'download'));
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    const rel = workspaceRef(currentBase, src);
    if (rel !== null) {
      node.setAttribute('src', fileUrl(rel, 'view'));
      node.setAttribute('loading', 'lazy');
    } else if (!src.startsWith('data:image/')) {
      // Remote images are blocked by the CSP; keep the alt text instead of a broken icon.
      node.replaceWith(document.createTextNode(node.getAttribute('alt') || src));
    }
  }
});

/**
 * Markdown from Codex → sanitized HTML. Relative links and images are resolved
 * against the session's workspace folder and served by the file API.
 */
export function renderMarkdown(text: string, workspaceBase: string | null): string {
  currentBase = workspaceBase;
  try {
    const html = marked.parse(text, { async: false });
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
      FORBID_ATTR: ['style'],
    });
  } finally {
    currentBase = null;
  }
}
