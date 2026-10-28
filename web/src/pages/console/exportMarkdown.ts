import type { SessionInfo, TranscriptEntry } from '../../../../shared/api.js';

const fence = (body: string, lang = '') => `\`\`\`${lang}\n${body.replace(/```/g, '`​``')}\n\`\`\``;

/** The conversation as Markdown, like Codex's `/export`. */
export function transcriptMarkdown(session: SessionInfo, entries: TranscriptEntry[], labels: { you: string; codex: string }): string {
  const out: string[] = [`# ${session.title || session.id}`, ''];
  for (const e of entries) {
    const item = e.data?.item;
    if (e.kind === 'userMessage') {
      const text = (item?.content ?? [])
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text: string }) => c.text)
        .join('\n')
        .replace(/\n\n\[Attached files in the workspace: [^\]]*\]$/, '');
      out.push(`## ${labels.you}`, '', text, '');
    } else if (e.kind === 'agentMessage' && item?.text) {
      out.push(`## ${labels.codex}`, '', String(item.text), '');
    } else if (e.kind === 'commandExecution' && item?.command) {
      out.push(fence(`$ ${item.command}${item.aggregatedOutput ? `\n${String(item.aggregatedOutput).trimEnd()}` : ''}`, 'console'), '');
    } else if (e.kind === 'fileChange' && Array.isArray(item?.changes)) {
      for (const c of item.changes) if (c.diff) out.push(fence(String(c.diff), 'diff'), '');
    } else if (e.kind === 'plan' && item?.text) {
      out.push(String(item.text), '');
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

export function downloadText(name: string, text: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
