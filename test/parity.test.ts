import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/api.js';
import { Client, makeHarness, pairAndLogin, waitForEvent, type Harness } from './helpers.js';

let h: Harness;
let c: Client;

beforeAll(async () => {
  h = await makeHarness();
  c = await pairAndLogin(h);
});
afterAll(async () => {
  await h?.close();
});

async function session(title = 'Parity') {
  return (await c.post('/api/sessions', { title })).json().session as { id: string; cwd: string; workspacePath: string };
}

async function prompt(id: string, text: string, extra: Record<string, unknown> = {}) {
  const done = waitForEvent(h, id, 'turn_completed');
  const res = await c.post(`/api/sessions/${id}/turns`, { text, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return done;
}

const history = async (id: string) => (await c.get(`/api/sessions/${id}/history`)).json().entries as Array<{ kind: string; turnId: string; data: any }>;

describe('Codex parity in the console', () => {
  it('changes per-session settings and reports effective values', async () => {
    const s = await session();
    const res = await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: true, model: 'gpt-fake-mini', effort: 'low' } });
    expect(res.json().effective).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', networkAccess: true, model: 'gpt-fake-mini', effort: 'low' });
    const reset = await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { sandbox: null, approvalPolicy: null, networkAccess: null } });
    expect(reset.json().effective).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request', networkAccess: false });
    expect((await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { sandbox: 'root' } })).statusCode).toBe(400);
  });

  it('forks a session from its latest or an earlier turn', async () => {
    const s = await session('Original');
    await prompt(s.id, 'first');
    await prompt(s.id, 'second');
    const turns = [...new Set((await history(s.id)).filter((e) => e.kind === 'turnEnd').map((e) => e.turnId))];
    expect(turns).toHaveLength(2);
    const full = (await c.post(`/api/sessions/${s.id}/fork`, {})).json().session;
    expect(full).toMatchObject({ title: 'Original (fork)', forkedFrom: s.id });
    expect((await history(full.id)).filter((e) => e.kind === 'turnEnd')).toHaveLength(2);
    const early = (await c.post(`/api/sessions/${s.id}/fork`, { turnId: turns[0] })).json().session;
    const earlyHistory = await history(early.id);
    expect(earlyHistory.filter((e) => e.kind === 'turnEnd')).toHaveLength(1);
    expect(earlyHistory.find((e) => e.kind === 'agentMessage')!.data.item.text).toContain('first');
    // The fork continues on its own thread.
    await prompt(early.id, 'continue the fork');
    expect((await history(s.id)).filter((e) => e.kind === 'turnEnd')).toHaveLength(2);
  });

  it('undoes the last turn (rewinding the Codex thread too)', async () => {
    const s = await session();
    await prompt(s.id, 'keep this');
    await prompt(s.id, 'drop this');
    const changed = waitForEvent(h, s.id, 'transcript_changed');
    expect((await c.post(`/api/sessions/${s.id}/undo`, {})).statusCode).toBe(200);
    await changed;
    const entries = await history(s.id);
    expect(entries.filter((e) => e.kind === 'turnEnd')).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('drop this');
    const row = h.runtime.sessions.get(s.id)!;
    const turns = await h.runtime.bridge.request<{ data: unknown[] }>('thread/turns/list', { threadId: row.thread_id });
    expect(turns.data).toHaveLength(1);
    expect((await c.post(`/api/sessions/${s.id}/undo`, { turnId: 'nope' })).json().error.code).toBe('turn_not_found');
  });

  it('steers a running turn', async () => {
    const s = await session();
    const streaming = waitForEvent(h, s.id, 'item_delta');
    const done = waitForEvent(h, s.id, 'turn_completed', 20_000);
    await c.post(`/api/sessions/${s.id}/turns`, { text: 'steady work' });
    await streaming;
    await new Promise((r) => setTimeout(r, 200));
    const steer = await c.post(`/api/sessions/${s.id}/steer`, { text: 'also add tests' });
    expect(steer.statusCode, steer.body).toBe(200);
    await done;
    const entries = await history(s.id);
    expect(entries.some((e) => e.kind === 'steer' && e.data.text === 'also add tests')).toBe(true);
    expect(entries.filter((e) => e.kind === 'agentMessage').pop()!.data.item.text).toContain('Steered with: also add tests');
    expect((await c.post(`/api/sessions/${s.id}/steer`, { text: 'late' })).json().error.code).toBe('no_active_turn');
  });

  it('compacts, reviews and runs !commands as their own turns', async () => {
    const s = await session();
    await prompt(s.id, 'something to compact');
    const compacted = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/sessions/${s.id}/compact`);
    expect((await compacted).event.type === 'turn_completed').toBe(true);
    const reviewed = waitForEvent(h, s.id, 'turn_completed');
    expect((await c.post(`/api/sessions/${s.id}/review`, { target: { type: 'baseBranch', branch: 'main' } })).statusCode).toBe(200);
    await reviewed;
    const shelled = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/sessions/${s.id}/shell`, { command: 'echo hi' });
    const { event } = await shelled;
    expect(event.type === 'turn_completed' && event.end.kind).toBe('shell');
    const entries = await history(s.id);
    expect(entries.some((e) => e.kind === 'contextCompaction')).toBe(true);
    expect(entries.some((e) => e.kind === 'agentMessage' && e.data.item.text.includes('Review of baseBranch'))).toBe(true);
    const shell = entries.find((e) => e.kind === 'commandExecution' && e.data.item.source === 'userShell')!;
    expect(shell.data.item.aggregatedOutput).toBe('fake shell: echo hi\n');
    const reqs = (await c.get(`/api/admin/requests?session=${s.id}`)).json().rows.map((r: { kind: string }) => r.kind);
    expect(reqs.sort()).toEqual(['compact', 'prompt', 'review', 'shell']);
    const sec = (await c.get('/api/admin/security?kind=shell_command')).json();
    expect(sec.rows[0].detail).toContain('echo hi');
  });

  it('runs slash commands', async () => {
    const s = await session('Commands');
    const run = async (command: string) => (await c.post(`/api/sessions/${s.id}/command`, { command })).json();
    expect((await run('/help')).commands.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['/model', '/review', '/undo', '!']));
    expect(await run('/model')).toMatchObject({ kind: 'models', current: null });
    expect((await run('/model gpt-fake-mini low')).effective).toMatchObject({ model: 'gpt-fake-mini', effort: 'low' });
    expect((await run('/model nope')).error.code).toBe('bad_request');
    expect((await run('/approvals never')).effective.approvalPolicy).toBe('never');
    expect((await run('/sandbox read-only')).effective.sandbox).toBe('read-only');
    expect((await run('/network on')).effective.networkAccess).toBe(true);
    expect((await run('/teleport')).error.code).toBe('unknown_command');
    const init = waitForEvent(h, s.id, 'turn_completed');
    expect((await run('/init')).kind).toBe('turn');
    await init;
    expect((await history(s.id)).find((e) => e.kind === 'userMessage')!.data.item.content[0].text).toContain('AGENTS.md');
    expect(await run('/status')).toMatchObject({ kind: 'status', status: { effective: { sandbox: 'read-only' }, contextWindow: 200000 } });
    const diff = await run('/diff');
    expect(diff).toMatchObject({ kind: 'diff', gitDiff: null, gitError: expect.stringContaining('Not a git repository') });
    fs.mkdirSync(path.join(s.cwd, '.git'));
    expect((await run('/diff')).gitDiff).toContain('fake change');
    expect((await run('/skills')).skills[0]).toMatchObject({ name: 'imagegen' });
    expect((await run('/goal Ship the feature')).goal).toMatchObject({ objective: 'Ship the feature', status: 'active' });
    expect((await run('/goal')).goal.objective).toBe('Ship the feature');
    expect((await run('/goal clear')).goal).toBeNull();
    const shell = waitForEvent(h, s.id, 'turn_completed');
    expect((await run('!pwd')).kind).toBe('turn');
    await shell;
    expect((await run('/new Brand new')).session).toMatchObject({ title: 'Brand new' });
    expect((await run('/fork')).session.forkedFrom).toBe(s.id);
    expect((await run('/mcp')).kind).toBe('mcp');
    expect((await run('/undo')).kind).toBe('done');
  });

  it('relays Codex questions and MCP forms, and MCP tool progress', async () => {
    const s = await session();
    const asked = waitForEvent(h, s.id, 'question_requested');
    const done = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/sessions/${s.id}/turns`, { text: 'question then elicit then mcp' });
    const { event } = await asked;
    if (event.type !== 'question_requested') throw new Error('unexpected');
    expect(event.question).toMatchObject({ kind: 'input', questions: [{ id: 'color', options: [{ label: 'Red' }, { label: 'Blue' }] }] });
    expect((await c.get('/api/approvals')).json().questions).toHaveLength(1);
    const form = waitForEvent(h, s.id, 'question_requested');
    await c.post(`/api/questions/${event.question.id}`, { kind: 'input', answers: { color: ['Red'] } });
    const second = (await form).event;
    if (second.type !== 'question_requested') throw new Error('unexpected');
    expect(second.question).toMatchObject({ kind: 'elicitation', server: 'docs', mode: 'form' });
    expect((await c.post(`/api/questions/${second.question.id}`, { kind: 'input', answers: {} })).json().error.code).toBe('bad_request');
    const progress: ServerEvent[] = [];
    const listener = (sid: string, ev: ServerEvent) => sid === s.id && ev.type === 'item_progress' && progress.push(ev);
    h.runtime.turns.on('event', listener);
    await c.post(`/api/questions/${second.question.id}`, { kind: 'elicitation', action: 'accept', content: { project: 'alpha' } });
    await done;
    h.runtime.turns.off('event', listener);
    expect(progress.map((e) => e.type === 'item_progress' && e.message)).toEqual(['Connecting…', 'Searching 2 sources…']);
    const entries = await history(s.id);
    const reply = entries.filter((e) => e.kind === 'agentMessage').pop()!.data.item.text;
    expect(reply).toContain('answer: Red');
    expect(reply).toContain('elicitation: accept alpha');
    expect(entries.filter((e) => e.kind === 'question')).toHaveLength(2);
    expect(entries.find((e) => e.kind === 'mcpToolCall')!.data.item).toMatchObject({ server: 'docs', tool: 'search', status: 'completed' });
  });

  it('sends @-mentions, skills and image links as Codex inputs', async () => {
    const s = await session();
    fs.writeFileSync(path.join(s.cwd, 'notes-for-codex.md'), '# hi');
    const found = (await c.get(`/api/sessions/${s.id}/search?q=notes`)).json().files;
    expect(found[0]).toEqual({ name: 'notes-for-codex.md', path: `${s.workspacePath}/notes-for-codex.md` });
    const { event } = await prompt(s.id, 'use these', { mentions: [found[0].path], skills: ['imagegen'], imageUrls: ['https://example.com/a.png'] });
    expect(event.type === 'turn_completed' && event.end.status).toBe('completed');
    const entries = await history(s.id);
    expect(entries.find((e) => e.kind === 'userMessage')!.data.item.content.map((x: { type: string }) => x.type)).toEqual(['text', 'mention', 'image', 'skill']);
    expect((await c.post(`/api/sessions/${s.id}/turns`, { text: 'x', skills: ['nope'] })).json().error.code).toBe('bad_request');
    expect((await c.post(`/api/sessions/${s.id}/turns`, { text: 'x', imageUrls: ['http://example.com/a.png'] })).json().error.code).toBe('bad_request');
    expect((await c.post(`/api/sessions/${s.id}/turns`, { text: 'x', mentions: ['../etc/passwd'] })).json().error.code).toBe('path_invalid');
  });

  it('keeps each turn’s diff for /diff and history', async () => {
    const s = await session();
    await prompt(s.id, 'edit a file');
    const end = (await history(s.id)).find((e) => e.kind === 'turnEnd')!;
    expect(end.data.diff).toContain('notes.md');
    expect((await c.get(`/api/sessions/${s.id}/diff`)).json().turnDiff).toContain('notes.md');
  });
});
