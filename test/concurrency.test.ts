import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/api.js';
import { makeHarness, signIn, waitForEvent, type Client, type Harness } from './helpers.js';

let h: Harness;
let client: Client;
beforeAll(async () => {
  h = await makeHarness();
  client = await signIn(h);
});
afterAll(async () => {
  await h?.close();
});

describe('concurrent sessions', () => {
  it('keeps events, approvals and history separate per session', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => (await client.post('/api/sessions', { title: `parallel ${i}` })).json().session as { id: string }),
    );
    // Every session's events must only mention its own prompt.
    const seen = new Map<string, ServerEvent[]>();
    const listener = (sid: string, ev: ServerEvent) => seen.set(sid, [...(seen.get(sid) ?? []), ev]);
    h.runtime.turns.on('event', listener);

    const approvalAsked = waitForEvent(h, sessions[0]!.id, 'approval_requested');
    const completions = sessions.map((s) => waitForEvent(h, s.id, 'turn_completed', 20_000));
    const starts = await Promise.all(
      sessions.map((s, i) => client.post(`/api/sessions/${s.id}/turns`, { text: i === 0 ? 'approve please #0' : `prompt number #${i}` })),
    );
    expect(starts.map((r) => r.statusCode)).toEqual(Array(8).fill(200));

    const { event } = await approvalAsked;
    if (event.type !== 'approval_requested') throw new Error('unexpected');
    expect(event.approval.sessionId).toBe(sessions[0]!.id);
    await client.post(`/api/approvals/${event.approval.id}`, { decision: 'acceptForSession' });

    const done = await Promise.all(completions);
    h.runtime.turns.off('event', listener);
    for (const d of done) expect(d.event.type === 'turn_completed' && d.event.end.status).toBe('completed');

    for (const [i, s] of sessions.entries()) {
      const history = (await client.get(`/api/sessions/${s.id}/history`)).json();
      const agent = history.entries.find((e: { kind: string }) => e.kind === 'agentMessage');
      expect(agent.data.item.text).toContain(`#${i}`);
      const others = sessions.map((_, j) => j).filter((j) => j !== i);
      for (const j of others) expect(agent.data.item.text).not.toContain(`#${j}”`);
      const evs = seen.get(s.id) ?? [];
      expect(evs.filter((e) => e.type === 'approval_requested')).toHaveLength(i === 0 ? 1 : 0);
    }
    const reqs = (await client.get('/api/admin/requests?limit=50')).json();
    expect(reqs.rows.filter((r: { status: string }) => r.status === 'completed')).toHaveLength(8);
    expect(h.runtime.turns.runningCount()).toBe(0);
  });
});
