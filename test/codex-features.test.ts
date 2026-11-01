import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/api.js';
import { totpCode } from '../server/auth/totp.js';
import { Client, createKey, makeHarness, signIn, waitForEvent, type Harness } from './helpers.js';

const endOf = (ev: ServerEvent) => (ev.type === 'turn_completed' ? ev.end : null);

/** Record what the console sends to Codex. */
function spyRequests(h: Harness) {
  const calls: Array<{ method: string; params: any }> = [];
  const bridge = h.runtime.bridge as unknown as { request: (m: string, p: unknown) => Promise<unknown> };
  const original = bridge.request.bind(bridge);
  bridge.request = (method, params) => {
    calls.push({ method, params });
    return original(method, params);
  };
  return { calls, last: (m: string) => [...calls].reverse().find((c) => c.method === m)?.params, restore: () => (bridge.request = original) };
}

describe('Codex features in the console', () => {
  let h: Harness;
  let c: Client;
  beforeAll(async () => {
    h = await makeHarness();
    c = await signIn(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  const newSession = async () => (await c.post('/api/sessions', { title: 'features' })).json().session as { id: string; cwd: string };
  const run = async (sid: string, body: Record<string, unknown>) => {
    const done = waitForEvent(h, sid, 'turn_completed');
    const res = await c.post(`/api/sessions/${sid}/turns`, body);
    expect(res.statusCode, res.body).toBe(200);
    return endOf((await done).event)!;
  };

  it('lists models with their real reasoning levels and speed tiers', async () => {
    const models = (await c.get('/api/codex/models')).json().models;
    expect(models.map((m: { id: string }) => m.id)).toEqual(['gpt-fake-1', 'gpt-fake-mini']);
    expect(models[0]).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      effortOptions: expect.arrayContaining([{ effort: 'high', description: 'Thinks longer on hard problems' }]),
      serviceTiers: [{ id: 'priority', name: 'Fast', description: expect.any(String) }],
      inputModalities: ['text', 'image'],
    });
  });

  it('sends model, reasoning, summary, speed, reviewer and folder with every turn, and spells out defaults', async () => {
    const s = await newSession();
    const spy = spyRequests(h);
    try {
      await run(s.id, { text: 'hello', model: 'gpt-fake-1', effort: 'high', summary: 'detailed', serviceTier: 'priority' });
      expect(spy.last('turn/start')).toMatchObject({ model: 'gpt-fake-1', effort: 'high', summary: 'detailed', serviceTierForTurn: 'priority', approvalsReviewer: 'user', cwd: s.cwd });
      // Back to defaults: Codex keeps overrides, so the default model and effort are named explicitly.
      await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { model: null, effort: null, summary: null, serviceTier: null } });
      await run(s.id, { text: 'again' });
      expect(spy.last('turn/start')).toMatchObject({ model: 'gpt-fake-1', effort: 'medium', serviceTierForTurn: 'default' });
      // An effort the model doesn't offer falls back to its default.
      await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { model: 'gpt-fake-mini', effort: 'xhigh' } });
      await run(s.id, { text: 'mini' });
      expect(spy.last('turn/start')).toMatchObject({ model: 'gpt-fake-mini', effort: 'low' });
    } finally {
      spy.restore();
    }
  });

  it('plans in Plan mode and switches back', async () => {
    const s = await newSession();
    const spy = spyRequests(h);
    try {
      await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { mode: 'plan' } });
      await run(s.id, { text: 'add a feature' });
      expect(spy.last('turn/start').collaborationMode).toMatchObject({ mode: 'plan', settings: { model: 'gpt-fake-1' } });
      const history = (await c.get(`/api/sessions/${s.id}/history`)).json().entries as Array<{ kind: string; data: any }>;
      expect(history.find((e) => e.kind === 'plan')?.data.item.text).toContain('Run the tests');
      await c.post(`/api/sessions/${s.id}/command`, { command: '/plan off' });
      await run(s.id, { text: 'do it' });
      expect(spy.last('turn/start').collaborationMode).toMatchObject({ mode: 'default' });
      await run(s.id, { text: 'and again' });
      expect(spy.last('turn/start').collaborationMode).toBeUndefined();
    } finally {
      spy.restore();
    }
  });

  it('offers every approval answer Codex supports', async () => {
    const s = await newSession();
    const ask = async (text: string) => {
      const asked = waitForEvent(h, s.id, 'approval_requested');
      await c.post(`/api/sessions/${s.id}/turns`, { text });
      const ev = (await asked).event;
      return ev.type === 'approval_requested' ? ev.approval : null!;
    };
    const finish = async (id: string, body: Record<string, unknown>) => {
      const done = waitForEvent(h, s.id, 'turn_completed');
      expect((await c.post(`/api/approvals/${id}`, body)).statusCode).toBe(200);
      await done;
      const entries = (await c.get(`/api/sessions/${s.id}/history`)).json().entries as Array<{ kind: string; data: any }>;
      return entries.filter((e) => e.kind === 'agentMessage').pop()!.data.item.text as string;
    };
    const a1 = await ask('please approve this');
    expect(a1.proposedRule).toEqual(['ls']);
    expect(await finish(a1.id, { decision: 'acceptAlways' })).toContain('approval: acceptWithExecpolicyAmendment');
    const a2 = await ask('approve the network call');
    expect(a2.networkRules).toEqual([{ action: 'allow', host: 'example.com' }]);
    expect(await finish(a2.id, { decision: 'applyNetworkRule', ruleIndex: 0 })).toContain('approval: applyNetworkPolicyAmendment');
    const a3 = await ask('please approve this');
    const done = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/approvals/${a3.id}`, { decision: 'cancel' });
    expect(endOf((await done).event)?.status).toBe('interrupted');
  });

  it('shows automatic reviews and lets the owner approve a denied action once', async () => {
    const s = await newSession();
    await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { approvalsReviewer: 'auto_review' } });
    const reviews: ServerEvent[] = [];
    const listener = (sid: string, ev: ServerEvent) => sid === s.id && ev.type === 'auto_review' && reviews.push(ev);
    h.runtime.turns.on('event', listener);
    try {
      await run(s.id, { text: 'approve but deny it' });
    } finally {
      h.runtime.turns.off('event', listener);
    }
    const last = reviews.at(-1);
    expect(last?.type === 'auto_review' && last.review).toMatchObject({ status: 'denied', riskLevel: 'high', action: 'ls -la' });
    const entry = (await c.get(`/api/sessions/${s.id}/history`)).json().entries.find((e: { kind: string }) => e.kind === 'autoReview');
    expect(entry.data.rationale).toContain('private files');
    const reviewId = last?.type === 'auto_review' ? last.review.reviewId : '';
    expect((await c.post(`/api/sessions/${s.id}/reviews/${reviewId}/approve`)).statusCode).toBe(200);
    expect((await c.post(`/api/sessions/${s.id}/reviews/${reviewId}/approve`)).json().error.code).toBe('approval_not_found');
  });

  it('queues prompts sent while Codex is busy and runs them in order', async () => {
    const s = await newSession();
    const started = waitForEvent(h, s.id, 'turn_started');
    await c.post(`/api/sessions/${s.id}/turns`, { text: 'steady please' });
    await started;
    expect((await c.post(`/api/sessions/${s.id}/queue`, { text: 'second' })).statusCode).toBe(200);
    const third = (await c.post(`/api/sessions/${s.id}/queue`, { text: 'third' })).json().queued;
    expect((await c.get(`/api/sessions/${s.id}/queue`)).json().queue.map((q: { text: string }) => q.text)).toEqual(['second', 'third']);
    await c.req('DELETE', `/api/sessions/${s.id}/queue/${third.id}`);
    // The queued prompt starts by itself after the running one completes.
    const prompts: string[] = [];
    const listener = (sid: string, ev: ServerEvent) => sid === s.id && ev.type === 'turn_started' && prompts.push(ev.prompt);
    h.runtime.turns.on('event', listener);
    const secondDone = new Promise<void>((resolve) => {
      const l = (sid: string, ev: ServerEvent) => {
        if (sid === s.id && ev.type === 'turn_completed' && prompts.includes('second')) {
          h.runtime.turns.off('event', l);
          resolve();
        }
      };
      h.runtime.turns.on('event', l);
    });
    await secondDone;
    h.runtime.turns.off('event', listener);
    expect(prompts).toEqual(['second']);
    expect((await c.get(`/api/sessions/${s.id}/queue`)).json().queue).toEqual([]);

    // A stopped turn pauses the queue until it is resumed.
    const busy = waitForEvent(h, s.id, 'turn_started');
    await c.post(`/api/sessions/${s.id}/turns`, { text: 'slow please' });
    await busy;
    await c.post(`/api/sessions/${s.id}/queue`, { text: 'later' });
    const stopped = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/sessions/${s.id}/interrupt`);
    await stopped;
    await new Promise((r) => setTimeout(r, 50));
    expect((await c.get(`/api/sessions/${s.id}/queue`)).json()).toMatchObject({ paused: true, queue: [{ text: 'later' }] });
    const resumed = waitForEvent(h, s.id, 'turn_completed');
    await c.post(`/api/sessions/${s.id}/queue/resume`);
    expect(endOf((await resumed).event)?.status).toBe('completed');
  });

  it('lists and stops background terminals', async () => {
    const s = await newSession();
    await run(s.id, { text: 'start a background server' });
    const list = (await c.get(`/api/sessions/${s.id}/terminals`)).json().terminals;
    expect(list).toEqual([expect.objectContaining({ command: 'npm run dev', osPid: 4242 })]);
    expect((await c.post(`/api/sessions/${s.id}/command`, { command: '/ps' })).json()).toMatchObject({ kind: 'terminals', terminals: [{ command: 'npm run dev' }] });
    await c.post(`/api/sessions/${s.id}/terminals/stop`, { processId: list[0].processId });
    expect((await c.get(`/api/sessions/${s.id}/terminals`)).json().terminals).toEqual([]);
  });

  it('applies web search, extra writable folders and memory', async () => {
    const s = await newSession();
    await run(s.id, { text: 'hello' });
    fs.mkdirSync(path.join(h.workspace, 'shared-lib'));
    const spy = spyRequests(h);
    try {
      const bad = await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { writableRoots: ['../../etc'] } });
      expect(bad.statusCode).toBe(400);
      const ok = await c.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { webSearch: 'live', writableRoots: ['shared-lib'], memory: false } });
      expect(ok.json().effective).toMatchObject({ webSearch: 'live', writableRoots: [fs.realpathSync(path.join(h.workspace, 'shared-lib'))] });
      expect(spy.last('thread/memoryMode/set')).toMatchObject({ mode: 'disabled' });
      await run(s.id, { text: 'search the web' });
      // Web search is thread config: the thread is loaded again with it.
      expect(spy.last('thread/resume')?.config).toMatchObject({ web_search: 'live' });
      expect(spy.last('turn/start').sandboxPolicy.writableRoots).toEqual([fs.realpathSync(path.join(h.workspace, 'shared-lib'))]);
    } finally {
      spy.restore();
    }
  });

  it('changes folder, renames, archives and deletes like Codex does', async () => {
    const s = await newSession();
    await run(s.id, { text: 'hello' });
    fs.mkdirSync(path.join(h.workspace, 'other-folder'));
    const cd = (await c.post(`/api/sessions/${s.id}/command`, { command: '/cd other-folder' })).json();
    expect(cd.session.cwd).toBe(fs.realpathSync(path.join(h.workspace, 'other-folder')));
    expect((await c.post(`/api/sessions/${s.id}/command`, { command: '/pwd' })).json()).toEqual({ kind: 'info', text: cd.session.cwd });
    expect((await c.post(`/api/sessions/${s.id}/command`, { command: '/cd ../..' })).json().error.code).toBe('path_invalid');
    const spy = spyRequests(h);
    try {
      await c.post(`/api/sessions/${s.id}/command`, { command: '/rename Better name' });
      expect(spy.last('thread/name/set')).toMatchObject({ name: 'Better name' });
      await c.post(`/api/sessions/${s.id}/command`, { command: '/archive' });
      expect(spy.calls.some((x) => x.method === 'thread/archive')).toBe(true);
      expect((await c.get(`/api/sessions/${s.id}`)).json().session.archivedAt).not.toBeNull();
      // A new prompt brings it back.
      await run(s.id, { text: 'back again' });
      expect(spy.calls.some((x) => x.method === 'thread/unarchive')).toBe(true);
      await c.req('DELETE', `/api/sessions/${s.id}?deleteThread=1`);
      expect(spy.calls.some((x) => x.method === 'thread/delete')).toBe(true);
    } finally {
      spy.restore();
    }
  });

  it('includes untracked files in the git diff', async () => {
    const s = await newSession();
    fs.mkdirSync(path.join(s.cwd, '.git'));
    const spy = spyRequests(h);
    try {
      expect((await c.get(`/api/sessions/${s.id}/diff`)).json().gitDiff).toContain('fake change');
      const exec = spy.last('command/exec');
      expect(exec.command.slice(0, 2)).toEqual(['sh', '-c']);
      expect(exec.command[2]).toContain('ls-files --others --exclude-standard');
      expect(exec.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    } finally {
      spy.restore();
    }
  });

  it('lists reusable prompts from CODEX_HOME/prompts', async () => {
    const dir = path.join(h.root, 'codex-home', 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review-pr.md'), '---\ndescription: Review a pull request\n---\nReview this PR carefully: $ARGUMENTS\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    expect((await c.get('/api/codex/prompts')).json().prompts).toEqual([{ name: 'review-pr', description: 'Review a pull request', content: 'Review this PR carefully: $ARGUMENTS\n' }]);
  });

  it('sends feedback only when asked, and logs it', async () => {
    const s = await newSession();
    const spy = spyRequests(h);
    try {
      expect((await c.post(`/api/sessions/${s.id}/feedback`, { classification: 'bug', reason: 'It broke', includeLogs: false })).statusCode).toBe(200);
      expect(spy.last('feedback/upload')).toMatchObject({ classification: 'bug', includeLogs: false });
    } finally {
      spy.restore();
    }
    const events = (await c.get('/api/admin/security?limit=50')).json().rows.map((r: { kind: string }) => r.kind);
    expect(events).toContain('feedback_sent');
  });
});

describe('Codex administration', () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => {
    h = await makeHarness();
    admin = await signIn(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('reads config with its layers and writes edits', async () => {
    const cfg = (await admin.get('/api/admin/codex/config')).json();
    expect(cfg.layers.map((l: { name: { type: string } }) => l.name.type)).toEqual(['user', 'system']);
    const res = await admin.req('PUT', '/api/admin/codex/config', { body: { edits: [{ keyPath: 'model_reasoning_summary', value: 'concise' }, { keyPath: 'web_search', value: 'cached' }] } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await admin.get('/api/admin/codex/config')).json().config).toMatchObject({ model_reasoning_summary: 'concise', web_search: 'cached' });
    expect((await admin.req('PUT', '/api/admin/codex/config', { body: { edits: [{ keyPath: 'bad key', value: 1 }] } })).statusCode).toBe(400);
    // New sessions pick up Codex's defaults.
    const s = (await admin.post('/api/sessions', {})).json().session;
    expect((await admin.get(`/api/sessions/${s.id}`)).json().effective).toMatchObject({ summary: 'concise' });
  });

  it('toggles experimental features, plugins and skills', async () => {
    const features = (await admin.get('/api/admin/codex/features')).json().features;
    expect(features.find((f: { name: string }) => f.name === 'memories')).toMatchObject({ enabled: false, stage: 'beta' });
    await admin.req('PUT', '/api/admin/codex/features', { body: { enablement: { memories: true } } });
    expect((await admin.get('/api/admin/codex/features')).json().features.find((f: { name: string }) => f.name === 'memories').enabled).toBe(true);
    const plugins = (await admin.get('/api/admin/codex/plugins')).json().marketplaces[0].plugins;
    expect(plugins.find((p: { name: string }) => p.name === 'github').installed).toBe(false);
    await admin.post('/api/admin/codex/plugins/install', { pluginName: 'github' });
    expect((await admin.get('/api/admin/codex/plugins')).json().marketplaces[0].plugins.find((p: { name: string }) => p.name === 'github').installed).toBe(true);
    await admin.post('/api/admin/codex/plugins/uninstall', { pluginId: 'github@openai-curated' });
    const skills = (await admin.get('/api/admin/codex/skills')).json().skills;
    await admin.post('/api/admin/codex/skills', { path: skills[0].path, enabled: false });
    expect((await admin.get('/api/admin/codex/skills')).json().skills[0].enabled).toBe(false);
    expect((await admin.post('/api/admin/codex/skills', { path: '/etc/passwd', enabled: true })).statusCode).toBe(404);
    expect((await admin.get('/api/admin/codex/hooks')).json().data[0].hooks[0]).toMatchObject({ event: 'preToolUse' });
    expect((await admin.get('/api/admin/codex/apps')).json().data[0]).toMatchObject({ name: 'Gmail' });
    const kinds = (await admin.get('/api/admin/security?limit=100')).json().rows.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['codex_features_changed', 'plugin_installed', 'plugin_uninstalled']));
  });

  it('manages memories, imports and diagnostics', async () => {
    expect((await admin.get('/api/admin/codex/memory')).json()).toEqual({ v2ConsolidatedThreads: 7, v2Ready: true });
    await admin.post('/api/admin/codex/memory/reset');
    expect((await admin.get('/api/admin/codex/memory')).json().v2ConsolidatedThreads).toBe(0);
    const detected = (await admin.get('/api/admin/codex/import')).json();
    expect(detected.items[0].description).toContain('AGENTS.md');
    expect((await admin.post('/api/admin/codex/import', { items: detected.items })).statusCode).toBe(200);
    const doctor = (await admin.post('/api/admin/codex/doctor')).json();
    expect(doctor).toMatchObject({ ok: true });
    expect(doctor.output).toContain('✓ installation');
    expect(doctor.output).not.toContain('\u001b[');
    expect((await admin.get('/api/admin/codex/warnings')).json().warnings).toEqual([]);
  });

  it('signs Codex out and back in with a device code, and reads usage', async () => {
    const usage = (await admin.get('/api/admin/codex/account')).json();
    expect(usage).toMatchObject({ signedIn: true, account: { type: 'chatgpt' }, usage: { summary: { lifetimeTokens: 4_200_000 } } });
    await admin.post('/api/admin/codex/logout');
    await new Promise((r) => setTimeout(r, 100));
    expect((await admin.get('/api/codex/status')).json().signedIn).toBe(false);
    const login = (await admin.post('/api/admin/codex/login', { mode: 'deviceCode' })).json();
    expect(login).toMatchObject({ url: 'https://auth.example.com/device', userCode: 'FAKE-1234' });
    await new Promise((r) => setTimeout(r, 400));
    expect((await admin.get('/api/codex/status')).json().signedIn).toBe(true);
    expect((await admin.post('/api/admin/codex/limit-reset')).json()).toEqual({ outcome: 'reset' });
    const kinds = (await admin.get('/api/admin/security?limit=100')).json().rows.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['codex_logout', 'codex_login_started', 'limit_reset_used']));
  });

  it('reads MCP resources', async () => {
    await admin.post('/api/admin/mcp', { name: 'docs', transport: 'stdio', command: 'npx' });
    const res = (await admin.get('/api/admin/mcp/docs/resource?uri=docs%3A%2F%2Freadme')).json();
    expect(res.contents[0]).toMatchObject({ uri: 'docs://readme', text: 'Contents of docs://readme' });
  });

  it('is admin-only', async () => {
    await admin.post('/api/auth/admin/lock');
    for (const url of ['/api/admin/codex/config', '/api/admin/codex/account', '/api/admin/codex/features']) {
      expect((await admin.get(url)).json().error.code).toBe('admin_required');
    }
    expect((await admin.post('/api/admin/codex/logout')).json().error.code).toBe('admin_required');
    await admin.post('/api/auth/admin', { password: h.password, code: totpCode(h.totpSecret, Date.now() + 60_000) });
  });
});

describe('API keys and the new settings', () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => {
    h = await makeHarness();
    admin = await signIn(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('keeps keys inside their caps for reviewer, web search and writable folders', async () => {
    const { client } = await createKey(h, admin);
    const s = (await client.post('/v1/sessions', { title: 'k' })).json().session;
    for (const body of [{ approvalsReviewer: 'auto_review' }, { webSearch: 'live' }, { writableRoots: ['x'] }]) {
      const res = await client.patch(`/v1/sessions/${s.id}/settings`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json().error.code).toBe('setting_not_allowed');
    }
    const ok = await client.patch(`/v1/sessions/${s.id}/settings`, { mode: 'plan', summary: 'concise', serviceTier: 'priority', effort: 'high' });
    expect(ok.json().effective).toMatchObject({ mode: 'plan', summary: 'concise', serviceTier: 'priority', effort: 'high', approvalsReviewer: 'user', webSearch: 'disabled' });
  });

  it('accepts per-turn options, an output schema and queued prompts', async () => {
    const { client } = await createKey(h, admin);
    const s = (await client.post('/v1/sessions', { title: 'k2' })).json().session;
    const spy = spyRequests(h);
    try {
      const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
      const res = await client.post(`/v1/sessions/${s.id}/turns`, { text: 'hi', effort: 'low', outputSchema: schema, wait: true });
      expect(res.json().status).toBe('completed');
      expect(spy.last('turn/start')).toMatchObject({ effort: 'low', outputSchema: schema, approvalsReviewer: 'user' });
    } finally {
      spy.restore();
    }
    const started = waitForEvent(h, s.id, 'turn_started');
    await client.post(`/v1/sessions/${s.id}/turns`, { text: 'steady please' });
    await started;
    const done = new Promise<string[]>((resolve) => {
      const prompts: string[] = [];
      const l = (sid: string, ev: ServerEvent) => {
        if (sid !== s.id) return;
        if (ev.type === 'turn_started') prompts.push(ev.prompt);
        if (ev.type === 'turn_completed' && prompts.length) {
          h.runtime.turns.off('event', l);
          resolve(prompts);
        }
      };
      h.runtime.turns.on('event', l);
    });
    expect((await client.post(`/v1/sessions/${s.id}/queue`, { text: 'queued via API' })).statusCode).toBe(200);
    expect(await done).toEqual(['queued via API']);
  });
});
