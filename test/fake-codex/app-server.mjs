#!/usr/bin/env node
// A stand-in for `codex app-server` (protocol of codex-cli 0.164.0) used by the
// tests and for trying the UI without a ChatGPT login. It never contacts OpenAI.
//
// Prompt keywords drive the scripted turn:
//   approve    -> asks to run a command and waits for the approval answer
//                 (with approvalPolicy "never" it runs without asking)
//   permission -> asks for extra network permission
//   question   -> asks a clarifying question (request_user_input) and waits
//   elicit     -> an MCP server asks for a form and waits
//   mcp        -> an MCP tool call with progress messages
//   image      -> writes fake-plot.png into the session folder and "views" it
//   video      -> writes clip.webm into the session folder
//   edit       -> reports a file change (and writes notes.md)
//   steady     -> streams for ~2 s, reporting token usage as it goes
//   slow       -> streams for ~20 s (use it to test Stop)
//   fail       -> the turn fails; "fail limit" fails with usageLimitExceeded
//
// Env: FAKE_CODEX_SIGNED_IN=0 (signed out), FAKE_CODEX_SEED=1 (one terminal thread),
//      FAKE_CODEX_DELAY_MS (delay between streamed chunks, default 15).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const DELAY = Number(process.env.FAKE_CODEX_DELAY_MS ?? 15);
const signedIn = process.env.FAKE_CODEX_SIGNED_IN !== '0';
const threads = new Map();
const loaded = new Set();
const pendingServerRequests = new Map();
const activeTurns = new Map();
const oauthDone = new Set();
const config = { model: null, model_reasoning_effort: null, mcp_servers: {} };
let configVersion = 0;
let usedPercent = 12;
let serverRequestSeq = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const rpcError = (code, message) => Object.assign(new Error(message), { code });
const zeroTokens = () => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

function makeThread(cwd, extra = {}) {
  return {
    id: uuid(), sessionId: uuid(), forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null, historyMode: 'full', modelProvider: 'openai',
    model: 'gpt-fake-1', reasoningEffort: 'medium', createdAt: nowSec(), updatedAt: nowSec(), recencyAt: null,
    status: { type: 'idle' }, path: null, cwd, cliVersion: '0.164.0', originator: 'codex_cli_rs', source: 'cli',
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    tokens: zeroTokens(), goal: null, ...extra,
  };
}
const wire = (t, includeTurns = false) => {
  const { tokens: _t, goal: _g, ...rest } = t;
  return { ...rest, turns: includeTurns ? t.turns : [] };
};

if (process.env.FAKE_CODEX_SEED === '1') {
  const t = makeThread(process.env.FAKE_CODEX_SEED_CWD ?? process.cwd(), { preview: 'Refactor the parser', name: 'Parser refactor' });
  const turnId = uuid();
  t.turns.push({
    id: turnId, rootTurnId: turnId, itemsView: 'full', status: 'completed', error: null,
    startedAt: nowSec() - 3600, completedAt: nowSec() - 3590, durationMs: 10_000,
    items: [
      { type: 'userMessage', id: uuid(), clientId: null, content: [{ type: 'text', text: 'Refactor the parser', text_elements: [] }] },
      { type: 'agentMessage', id: uuid(), text: 'Done — the parser now uses a **table-driven** lexer.', phase: null, memoryCitation: null, delivery: null, questions: null },
    ],
  });
  threads.set(t.id, t);
}

// Minimal PNG encoder (RGB gradient) so "image" turns produce a real picture.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function gradientPng(w = 160, h = 96) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255); raw[o + 1] = Math.round((y / h) * 200) + 30; raw[o + 2] = 200;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function serverRequest(method, params) {
  const id = `srv-${++serverRequestSeq}`;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ id, method, params });
  });
}

/** Add one model step's usage to the thread total and report it (Codex reports cumulative totals). */
function addUsage(thread, turnId, last) {
  for (const k of Object.keys(thread.tokens)) thread.tokens[k] += last[k] ?? 0;
  notify('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: { ...thread.tokens }, last, modelContextWindow: 200_000 } });
}
const step = (input, cached, output, reasoning) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning });

async function streamText(threadId, turnId, itemId, method, text, extra, ctl, delay = DELAY, onWord) {
  const parts = text.match(/\S+\s*|\s+/g) ?? [];
  for (let i = 0; i < parts.length; i++) {
    if (ctl.interrupted) return false;
    notify(method, { threadId, turnId, itemId, delta: parts[i], ...extra });
    onWord?.(i);
    await sleep(delay);
  }
  return true;
}

/** Bookkeeping shared by prompts and Codex-initiated turns (review, compact, shell). */
function beginTurn(thread, input = []) {
  const turn = { id: uuid(), rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: nowSec(), completedAt: null, durationMs: null, input };
  const ctl = { interrupted: false, steers: [], startedMs: Date.now() };
  activeTurns.set(turn.id, ctl);
  notify('turn/started', { threadId: thread.id, turn: { ...wireTurn(turn) } });
  const itemStart = (item) => notify('item/started', { item, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
  const itemDone = (item) => {
    notify('item/completed', { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
    turn.items.push(item);
  };
  const finish = (status, error = null) => {
    activeTurns.delete(turn.id);
    const done = { ...wireTurn(turn), status, error, completedAt: nowSec(), durationMs: Date.now() - ctl.startedMs, items: [] };
    thread.turns.push({ ...done, items: turn.items, itemsView: 'full' });
    thread.updatedAt = nowSec();
    usedPercent = Math.min(100, usedPercent + 3);
    notify('account/rateLimits/updated', { rateLimits: rateLimits() });
    notify('turn/completed', { threadId: thread.id, turn: done });
  };
  return { turn, ctl, itemStart, itemDone, finish };
}
/** A turn the server starts on its own (goal continuation): reasoning, usage, a short reply. */
async function autoTurn(thread) {
  const h = beginTurn(thread, []);
  const msg = { type: 'agentMessage', id: uuid(), text: '', phase: null, memoryCitation: null };
  h.itemStart(msg);
  addUsage(thread, h.turn.id, step(600, 0, 100, 0));
  const text = 'Continuing the goal on my own.';
  const ok = await streamText(thread.id, h.turn.id, msg.id, 'item/agentMessage/delta', text, {}, h.ctl, 40);
  if (!ok) return h.finish('interrupted');
  h.itemDone({ ...msg, text });
  addUsage(thread, h.turn.id, step(200, 0, 100, 0));
  h.finish('completed');
}
function wireTurn(turn) {
  const { input: _i, approvalPolicy: _a, ...rest } = turn;
  return rest;
}

async function runTurn(thread, turnHandle, text) {
  const { turn, ctl, itemStart, itemDone, finish } = turnHandle;
  const threadId = thread.id;
  const turnId = turn.id;
  const lower = text.toLowerCase();
  const cwd = thread.cwd;

  const user = { type: 'userMessage', id: uuid(), clientId: null, content: turn.input };
  itemStart(user); itemDone(user);

  const reasoning = { type: 'reasoning', id: uuid(), summary: [], content: [] };
  itemStart(reasoning);
  const summary = '**Planning** I will look at the folder and then answer.';
  if (!(await streamText(threadId, turnId, reasoning.id, 'item/reasoning/summaryTextDelta', summary, { summaryIndex: 0 }, ctl))) return finish('interrupted');
  itemDone({ ...reasoning, summary: [summary] });
  addUsage(thread, turnId, step(800, 300, 200, 50));

  notify('turn/plan/updated', { threadId, turnId, explanation: null, plan: [{ step: 'Inspect the folder', status: 'completed' }, { step: 'Answer', status: 'inProgress' }] });

  if (lower.includes('fail')) {
    const info = lower.includes('limit') ? 'usageLimitExceeded' : 'other';
    const message = info === 'usageLimitExceeded' ? "You've hit your usage limit." : 'Simulated failure';
    notify('error', { error: { message, codexErrorInfo: info, additionalDetails: null, misalignment: null }, willRetry: false, threadId, turnId });
    return finish('failed', { message, codexErrorInfo: info, additionalDetails: null, misalignment: null });
  }

  const notes = [];
  if (lower.includes('permission')) {
    const res = await serverRequest('item/permissions/requestApproval', {
      threadId, turnId, itemId: uuid(), environmentId: null, startedAtMs: Date.now(), cwd, reason: 'Needs network to download data',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    notes.push(`permission scope: ${res?.scope ?? 'none'}`);
  }

  if (lower.includes('question')) {
    const res = await serverRequest('item/tool/requestUserInput', {
      threadId, turnId, itemId: uuid(), isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'color', header: 'Color', question: 'Which color should I use?', isOther: true, isSecret: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }],
    });
    if (ctl.interrupted) return finish('interrupted');
    notes.push(`answer: ${res?.answers?.color?.answers?.join(',') || 'none'}`);
  }

  if (lower.includes('elicit')) {
    const res = await serverRequest('mcpServer/elicitation/request', {
      threadId, turnId, serverName: 'docs', mode: 'form', _meta: null, message: 'Which project should I search?',
      requestedSchema: { type: 'object', properties: { project: { type: 'string', title: 'Project' } }, required: ['project'] },
    });
    if (ctl.interrupted) return finish('interrupted');
    notes.push(`elicitation: ${res?.action}${res?.content?.project ? ` ${res.content.project}` : ''}`);
  }

  if (lower.includes('mcp')) {
    const call = { type: 'mcpToolCall', id: uuid(), server: 'docs', tool: 'search', status: 'inProgress', arguments: { q: 'console' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null };
    itemStart(call);
    for (const message of ['Connecting…', 'Searching 2 sources…']) {
      notify('item/mcpToolCall/progress', { threadId, turnId, itemId: call.id, message });
      await sleep(DELAY);
    }
    itemDone({ ...call, status: 'completed', result: { content: [{ type: 'text', text: '2 results' }], structuredContent: null, _meta: null }, durationMs: 30 });
  }

  if (lower.includes('approve')) {
    const cmd = { type: 'commandExecution', id: uuid(), pluginId: null, scriptPath: null, command: 'ls -la', cwd, processId: null, source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    itemStart(cmd);
    let allowed = true;
    if (turn.approvalPolicy !== 'never') {
      const answer = await serverRequest('item/commandExecution/requestApproval', {
        kind: 'command', threadId, turnId, itemId: cmd.id, startedAtMs: Date.now(), approvalId: null, environmentId: null,
        reason: 'List the files to see what is there', command: 'ls -la', cwd, commandActions: [],
      });
      if (ctl.interrupted) return finish('interrupted');
      allowed = answer?.decision === 'accept' || answer?.decision === 'acceptForSession';
    }
    if (allowed) {
      const output = fs.readdirSync(cwd).map((f) => `-rw-r--r-- 1 owner owner 0 ${f}`).join('\n') + '\n';
      await streamText(threadId, turnId, cmd.id, 'item/commandExecution/outputDelta', output, {}, ctl);
      itemDone({ ...cmd, status: 'completed', aggregatedOutput: output, exitCode: 0, durationMs: 42 });
    } else {
      itemDone({ ...cmd, status: 'declined' });
    }
  }

  if (lower.includes('image')) {
    const file = path.join(cwd, 'fake-plot.png');
    fs.writeFileSync(file, gradientPng());
    const cmd = { type: 'commandExecution', id: uuid(), pluginId: null, scriptPath: null, command: 'python plot.py', cwd, processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: 'saved fake-plot.png\n', exitCode: 0, durationMs: 120 };
    itemStart({ ...cmd, status: 'inProgress', aggregatedOutput: null }); itemDone(cmd);
    const view = { type: 'imageView', id: uuid(), path: file };
    itemStart(view); itemDone(view);
  }

  if (lower.includes('video')) {
    fs.writeFileSync(path.join(cwd, 'clip.webm'), Buffer.from('1a45dfa3', 'hex'));
  }

  if (lower.includes('edit')) {
    const file = path.join(cwd, 'notes.md');
    fs.writeFileSync(file, '# Notes\n\nHello from Codex.\n');
    const change = { type: 'fileChange', id: uuid(), changes: [{ path: file, kind: { type: 'add' }, diff: '+# Notes\n+\n+Hello from Codex.\n' }], status: 'inProgress' };
    itemStart(change);
    notify('turn/diff/updated', { threadId, turnId, diff: 'diff --git a/notes.md b/notes.md\nnew file mode 100644\n+# Notes\n' });
    itemDone({ ...change, status: 'completed' });
  }

  const message = { type: 'agentMessage', id: uuid(), text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
  itemStart(message);
  const slow = lower.includes('slow');
  const steady = lower.includes('steady');
  const inputs = turn.input.filter((i) => i.type !== 'text');
  const kinds = inputs.map((i) => i.type).join(',');
  const reply = slow || steady
    ? Array.from({ length: slow ? 200 : 40 }, (_, i) => `step ${i + 1} `).join('')
    : `Here is what I found in \`${path.basename(cwd)}\`:\n\n- The folder has **${fs.readdirSync(cwd).length}** entries.\n- Your prompt was: “${text.slice(0, 80)}”.\n${kinds ? `- Extra inputs: ${kinds}\n` : ''}${notes.map((n) => `- ${n}\n`).join('')}\n\`\`\`bash\necho "hello from the fake Codex"\n\`\`\`\n`;
  // Long streams report usage as they go, like Codex does between model steps.
  const onWord = steady || slow ? (i) => { if (i > 0 && i % 10 === 0) addUsage(thread, turnId, step(300, 0, 50, 0)); } : undefined;
  const ok = await streamText(threadId, turnId, message.id, 'item/agentMessage/delta', reply, {}, ctl, slow ? 100 : steady ? 50 : DELAY, onWord);
  if (!ok) return finish('interrupted');
  const steerNote = ctl.steers.length ? `\n\nSteered with: ${ctl.steers.join(' | ')}` : '';
  if (steerNote) notify('item/agentMessage/delta', { threadId, turnId, itemId: message.id, delta: steerNote });
  itemDone({ ...message, text: reply + steerNote });

  addUsage(thread, turnId, step(400, 100, 400, 70));
  if (!thread.name) {
    thread.name = text.slice(0, 30);
    notify('thread/name/updated', { threadId, threadName: thread.name });
  }
  finish('completed');
}

function rateLimits() {
  return {
    limitId: 'codex', limitName: null, normalModelSlug: null,
    primary: { usedPercent, windowDurationMins: 300, resetsAt: nowSec() + 3 * 3600 },
    secondary: { usedPercent: Math.min(100, Math.round(usedPercent / 2) + 20), windowDurationMins: 10080, resetsAt: nowSec() + 4 * 86400 },
    credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null,
  };
}

function getThread(id, mustBeLoaded = false) {
  const t = threads.get(id);
  if (!t) throw rpcError(-32600, `thread not found: ${id}`);
  if (mustBeLoaded && !loaded.has(t.id)) throw rpcError(-32600, 'thread not loaded');
  return t;
}

function setPath(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (value === null) delete cur[last];
  else cur[last] = value;
}

function searchFiles(root, query, out, rel = '', depth = 0) {
  if (depth > 4 || out.length >= 50) return;
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) searchFiles(root, query, out, p, depth + 1);
    else if (d.name.toLowerCase().includes(query.toLowerCase())) out.push({ root, path: p, match_type: 'file', file_name: d.name, score: 100, indices: null });
  }
}

const handlers = {
  initialize: () => ({ userAgent: `codex_console/0.164.0 (fake; ${process.platform}) fake`, codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: process.platform }),
  'account/read': () => (signedIn ? { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true }),
  'account/rateLimits/read': () => {
    if (!signedIn) throw rpcError(-32600, 'codex account authentication required to read rate limits');
    return { ordinaryUsageAllowed: true, rateLimits: rateLimits(), rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null };
  },
  'model/list': () => ({
    data: [
      { id: 'gpt-fake-1', model: 'gpt-fake-1', displayName: 'GPT Fake 1', description: 'Default test model', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }] },
      { id: 'gpt-fake-mini', model: 'gpt-fake-mini', displayName: 'GPT Fake Mini', description: 'Fast test model', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] },
    ],
    nextCursor: null,
  }),
  'thread/start': (p) => {
    const t = makeThread(p?.cwd ?? process.cwd(), { model: p?.model ?? 'gpt-fake-1' });
    threads.set(t.id, t);
    loaded.add(t.id);
    notify('thread/started', { thread: wire(t) });
    return { thread: wire(t), model: t.model, modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: t.cwd, instructionSources: [], approvalPolicy: p?.approvalPolicy ?? 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: 'medium' };
  },
  'thread/resume': (p) => {
    const t = getThread(p.threadId);
    loaded.add(t.id);
    return { thread: wire(t, !p.excludeTurns), model: t.model, modelProvider: 'openai', cwd: t.cwd };
  },
  'thread/read': (p) => ({ thread: wire(getThread(p.threadId), Boolean(p.includeTurns)) }),
  'thread/list': (p) => {
    const excluded = new Set(p?.excludedThreadIds ?? []);
    const data = [...threads.values()].filter((t) => !excluded.has(t.id) && !t.forkedFromId).map((t) => wire(t));
    return { data, nextCursor: null, backwardsCursor: null };
  },
  'thread/turns/list': (p) => ({ data: getThread(p.threadId).turns, nextCursor: null, backwardsCursor: null }),
  'thread/archive': () => ({}),
  'thread/name/set': (p) => {
    getThread(p.threadId).name = p.name;
    return {};
  },
  'thread/fork': (p) => {
    const src = getThread(p.threadId);
    const cut = p.lastTurnId ? src.turns.findIndex((x) => x.id === p.lastTurnId) : src.turns.length - 1;
    if (p.lastTurnId && cut === -1) throw rpcError(-32600, 'turn not found');
    const t = makeThread(src.cwd, { forkedFromId: src.id, model: src.model, preview: src.preview, turns: src.turns.slice(0, cut + 1), tokens: { ...src.tokens } });
    threads.set(t.id, t);
    loaded.add(t.id);
    return { thread: wire(t, !p.excludeTurns), model: t.model, modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: t.cwd, instructionSources: [], approvalPolicy: p.approvalPolicy ?? 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: 'medium' };
  },
  'thread/revert': (p) => {
    const t = getThread(p.threadId, true);
    const i = t.turns.findIndex((x) => x.id === p.beforeTurnId);
    if (i === -1) throw rpcError(-32600, 'turn not found');
    t.turns = t.turns.slice(0, i);
    return { thread: wire(t), turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  },
  'turn/start': (p) => {
    const t = getThread(p.threadId, true);
    const text = (p.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    if (!t.preview) t.preview = text.slice(0, 100);
    const handle = beginTurnDeferred(t, p.input ?? []);
    handle.turn.approvalPolicy = p.approvalPolicy;
    setTimeout(() => {
      handle.start();
      void runTurn(t, handle, text);
    }, 5);
    return { turn: wireTurn(handle.turn) };
  },
  'turn/steer': (p) => {
    const ctl = activeTurns.get(p.expectedTurnId);
    if (!ctl) throw rpcError(-32600, 'no active turn to steer');
    const text = (p.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    ctl.steers.push(text);
    const item = { type: 'userMessage', id: uuid(), clientId: null, content: p.input };
    notify('item/started', { item, threadId: p.threadId, turnId: p.expectedTurnId, startedAtMs: Date.now() });
    notify('item/completed', { item, threadId: p.threadId, turnId: p.expectedTurnId, completedAtMs: Date.now() });
    return { turnId: p.expectedTurnId };
  },
  'turn/interrupt': (p) => {
    const ctl = activeTurns.get(p.turnId);
    if (ctl) ctl.interrupted = true;
    for (const [id, resolve] of pendingServerRequests) {
      pendingServerRequests.delete(id);
      resolve({ decision: 'cancel' });
    }
    return {};
  },
  'thread/compact/start': (p) => {
    const t = getThread(p.threadId, true);
    setTimeout(async () => {
      const h = beginTurn(t);
      const item = { type: 'contextCompaction', id: uuid() };
      h.itemStart(item);
      await sleep(DELAY);
      h.itemDone(item);
      h.finish('completed');
    }, 5);
    return {};
  },
  'review/start': (p) => {
    const t = getThread(p.threadId, true);
    const handle = beginTurnDeferred(t, []);
    setTimeout(async () => {
      handle.start();
      const label = p.target?.type === 'custom' ? p.target.instructions : p.target?.type ?? 'changes';
      const entered = { type: 'enteredReviewMode', id: uuid(), review: label };
      handle.itemStart(entered); handle.itemDone(entered);
      const msg = { type: 'agentMessage', id: uuid(), text: `Review of ${label}: no blocking issues found.`, phase: null, memoryCitation: null, delivery: null, questions: null };
      handle.itemStart({ ...msg, text: '' }); handle.itemDone(msg);
      const exited = { type: 'exitedReviewMode', id: uuid(), review: label };
      handle.itemStart(exited); handle.itemDone(exited);
      addUsage(t, handle.turn.id, step(500, 0, 150, 20));
      handle.finish('completed');
    }, 5);
    return { turn: wireTurn(handle.turn), reviewThreadId: t.id };
  },
  'thread/shellCommand': (p) => {
    const t = getThread(p.threadId, true);
    setTimeout(async () => {
      const h = beginTurn(t);
      const cmd = { type: 'commandExecution', id: uuid(), pluginId: null, scriptPath: null, command: p.command, cwd: t.cwd, processId: null, source: 'userShell', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
      h.itemStart(cmd);
      const output = `fake shell: ${p.command}\n`;
      notify('item/commandExecution/outputDelta', { threadId: t.id, turnId: h.turn.id, itemId: cmd.id, delta: output });
      await sleep(DELAY);
      h.itemDone({ ...cmd, status: 'completed', aggregatedOutput: output, exitCode: 0, durationMs: 5 });
      h.finish('completed');
    }, 5);
    return {};
  },
  // Only `git diff` is simulated, and only under a read-only sandbox (as the console must use it).
  'command/exec': (p) => {
    const cmd = p.command ?? [];
    if (cmd[0] !== 'git' || !cmd.includes('diff')) return { exitCode: 127, stdout: '', stderr: `fake: ${cmd[0]}: command not available\n` };
    if (p.sandboxPolicy?.type !== 'readOnly') throw rpcError(-32600, 'fake: git diff must run in a read-only sandbox');
    if (!fs.existsSync(path.join(p.cwd, '.git'))) {
      return { exitCode: 129, stdout: '', stderr: 'warning: Not a git repository. Use --no-index to compare two paths outside a working tree\nusage: git diff --no-index [<options>] <path> <path>\n' };
    }
    return { exitCode: 0, stdout: 'diff --git a/notes.md b/notes.md\n+fake change\n', stderr: '' };
  },
  'skills/list': (p) => ({
    data: [{ cwd: p?.cwds?.[0] ?? '', skills: [{ name: 'imagegen', description: 'Generate images', path: '/fake/skills/imagegen/SKILL.md', scope: 'system', enabled: true, pluginId: null }], errors: [] }],
  }),
  fuzzyFileSearch: (p) => {
    const out = [];
    for (const root of p.roots ?? []) if (fs.existsSync(root)) searchFiles(root, p.query ?? '', out);
    return { files: out };
  },
  'thread/goal/get': (p) => ({ goal: getThread(p.threadId).goal }),
  'thread/goal/set': (p) => {
    const t = getThread(p.threadId, true);
    t.goal = { threadId: t.id, objective: p.objective, status: p.status ?? 'active', tokenBudget: p.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: nowSec(), updatedAt: nowSec() };
    notify('thread/goal/updated', { threadId: t.id, turnId: null, goal: t.goal });
    // Like Codex's goal continuation: a turn nobody asked for, started by the server itself.
    if (/autostart/i.test(p.objective ?? '')) setTimeout(() => void autoTurn(t), 30);
    return { goal: t.goal };
  },
  'thread/goal/clear': (p) => {
    const t = getThread(p.threadId);
    t.goal = null;
    notify('thread/goal/cleared', { threadId: t.id });
    return {};
  },
  'config/read': () => ({ config: JSON.parse(JSON.stringify(config)), origins: {}, layers: null }),
  'config/value/write': (p) => {
    setPath(config, p.keyPath, p.value);
    return { status: 'ok', version: `v${++configVersion}`, filePath: '/tmp/fake-codex-home/config.toml', overriddenMetadata: null };
  },
  'config/mcpServer/reload': () => ({}),
  'mcpServerStatus/list': () => ({
    data: Object.entries(config.mcp_servers).map(([name, c]) => ({
      name,
      runtimeStatus: c.enabled === false ? null : 'connected',
      pluginId: null,
      httpOrigin: c.url ? new URL(c.url).origin : null,
      serverInfo: { name: `${name}-server`, title: null, version: '1.0.0', description: null, icons: null, websiteUrl: null },
      serverCapabilities: null,
      toolListMeta: null,
      tools: c.enabled === false ? {} : { echo: { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object' } } },
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: c.url ? (oauthDone.has(name) ? 'oAuth' : 'notLoggedIn') : 'unsupported',
    })),
    nextCursor: null,
  }),
  'mcpServer/oauth/login': (p) => {
    if (!config.mcp_servers[p.name]) throw rpcError(-32600, `unknown MCP server ${p.name}`);
    const loginId = uuid();
    setTimeout(() => {
      oauthDone.add(p.name);
      notify('mcpServer/oauthLogin/completed', { name: p.name, threadId: null, loginId, success: true });
    }, 50);
    return { authorizationUrl: `https://auth.example.com/authorize?server=${encodeURIComponent(p.name)}`, loginId };
  },
};

/** A turn whose turn/started notification is sent once the response has gone out. */
function beginTurnDeferred(thread, input) {
  let h = null;
  const turn = { id: uuid(), rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null, input };
  const handle = {
    turn,
    get ctl() { return h.ctl; },
    start() {
      h = beginTurnWith(thread, turn);
      Object.assign(handle, { itemStart: h.itemStart, itemDone: h.itemDone, finish: h.finish });
    },
  };
  return handle;
}
function beginTurnWith(thread, turn) {
  const ctl = { interrupted: false, steers: [], startedMs: Date.now() };
  activeTurns.set(turn.id, ctl);
  turn.startedAt = nowSec();
  notify('turn/started', { threadId: thread.id, turn: { ...wireTurn(turn) } });
  const itemStart = (item) => notify('item/started', { item, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
  const itemDone = (item) => {
    notify('item/completed', { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
    turn.items.push(item);
  };
  const finish = (status, error = null) => {
    activeTurns.delete(turn.id);
    const done = { ...wireTurn(turn), status, error, completedAt: nowSec(), durationMs: Date.now() - ctl.startedMs, items: [] };
    thread.turns.push({ ...done, items: turn.items, itemsView: 'full' });
    thread.updatedAt = nowSec();
    usedPercent = Math.min(100, usedPercent + 3);
    notify('account/rateLimits/updated', { rateLimits: rateLimits() });
    notify('turn/completed', { threadId: thread.id, turn: done });
  };
  return { ctl, itemStart, itemDone, finish };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pendingServerRequests.get(msg.id);
    if (resolve) {
      pendingServerRequests.delete(msg.id);
      resolve(msg.result ?? null);
    }
    return;
  }
  if (msg.id === undefined) return; // notification (e.g. "initialized")
  if (process.env.FAKE_CODEX_CRASH_ON === msg.method) process.exit(3);
  const handler = handlers[msg.method];
  if (!handler) return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  try {
    send({ id: msg.id, result: await handler(msg.params) });
  } catch (err) {
    send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
