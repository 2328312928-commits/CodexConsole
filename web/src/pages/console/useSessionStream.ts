import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ActiveTurnSnapshot, ApprovalInfo, AutoReview, LiveItem, PendingQuestion, QueuedPrompt, ServerEvent, SessionInfo, ThreadGoal, TranscriptEntry, TurnKind } from '../../../../shared/api.js';
import type { ThreadItem, TokenUsageBreakdown, TurnPlanStep } from '../../../../shared/codex.js';
import { authEvents, get, qs } from '../../api';

export interface LiveTurn {
  requestId: string;
  kind: TurnKind;
  turnId: string | null;
  prompt: string;
  startedAt: number;
  items: LiveItem[];
  plan: { explanation: string | null; steps: TurnPlanStep[] } | null;
  diff: string | null;
  usage: TokenUsageBreakdown | null;
  statusMessage: string | null;
  /** Steering messages sent from this page, shown until Codex echoes them. */
  steers: string[];
}

interface State {
  entries: TranscriptEntry[];
  hasMore: boolean;
  loaded: boolean;
  error: unknown;
  live: LiveTurn | null;
  approvals: ApprovalInfo[];
  questions: PendingQuestion[];
  /** Automatic reviews of the running turn's approval requests. */
  reviews: AutoReview[];
  queue: { queue: QueuedPrompt[]; paused: boolean };
  /** Latest goal from the stream; undefined until Codex reports one. */
  goal: ThreadGoal | null | undefined;
  connected: boolean;
}

type Action =
  | { type: 'reset' }
  | { type: 'history'; entries: TranscriptEntry[]; hasMore: boolean; clearLive?: string }
  | { type: 'older'; entries: TranscriptEntry[]; hasMore: boolean }
  | { type: 'error'; error: unknown }
  | { type: 'connected'; value: boolean }
  | { type: 'events'; events: ServerEvent[] }
  | { type: 'optimistic'; requestId: string; turnId: string | null; prompt: string; kind: TurnKind }
  | { type: 'steer'; text: string };

const initial: State = {
  entries: [],
  hasMore: false,
  loaded: false,
  error: null,
  live: null,
  approvals: [],
  questions: [],
  reviews: [],
  queue: { queue: [], paused: false },
  goal: undefined,
  connected: false,
};

function fromSnapshot(s: ActiveTurnSnapshot): LiveTurn {
  return {
    requestId: s.requestId,
    kind: s.kind,
    turnId: s.turnId,
    prompt: s.prompt,
    startedAt: s.startedAt,
    items: s.items,
    plan: s.plan,
    diff: s.diff,
    usage: s.usage,
    statusMessage: s.statusMessage,
    steers: [],
  };
}

function emptyLive(requestId: string, turnId: string | null, prompt: string, kind: TurnKind = 'prompt', startedAt = Date.now()): LiveTurn {
  return { requestId, kind, turnId, prompt, startedAt, items: [], plan: null, diff: null, usage: null, statusMessage: null, steers: [] };
}

function upsertItem(items: LiveItem[], next: LiveItem): LiveItem[] {
  const i = items.findIndex((x) => x.item.id === next.item.id);
  if (i === -1) return [...items, next];
  const copy = items.slice();
  copy[i] = next;
  return copy;
}

function applyDelta(item: ThreadItem & Record<string, any>, field: 'text' | 'summary' | 'output' | 'content', delta: string, index = 0): ThreadItem {
  if (field === 'text') return { ...item, text: (item.text ?? '') + delta };
  if (field === 'output') return { ...item, aggregatedOutput: (item.aggregatedOutput ?? '') + delta };
  const key = field === 'content' ? 'content' : 'summary';
  const parts: string[] = Array.isArray(item[key]) ? item[key].slice() : [];
  while (parts.length <= index) parts.push('');
  parts[index] += delta;
  return { ...item, [key]: parts };
}

function applyEvent(state: State, ev: ServerEvent): State {
  switch (ev.type) {
    case 'snapshot':
      return {
        ...state,
        live: ev.turn ? fromSnapshot(ev.turn) : null,
        approvals: ev.turn?.approvals ?? [],
        questions: ev.turn?.questions ?? [],
        reviews: ev.turn?.reviews ?? [],
      };
    case 'turn_started': {
      const live =
        state.live && state.live.requestId === ev.requestId
          ? { ...state.live, turnId: ev.turnId, kind: ev.kind }
          : emptyLive(ev.requestId, ev.turnId, ev.prompt, ev.kind, ev.startedAt);
      return { ...state, live };
    }
    case 'item_started': {
      const live = state.live ?? emptyLive('', ev.turnId, '');
      return { ...state, live: { ...live, items: upsertItem(live.items, { item: ev.item, done: false, media: [] }) } };
    }
    case 'item_delta': {
      if (!state.live) return state;
      const existing = state.live.items.find((x) => x.item.id === ev.itemId);
      if (!existing) return state;
      const item = applyDelta(existing.item as ThreadItem & Record<string, any>, ev.field, ev.delta, ev.index);
      return { ...state, live: { ...state.live, items: upsertItem(state.live.items, { ...existing, item }) } };
    }
    case 'item_progress': {
      if (!state.live) return state;
      const existing = state.live.items.find((x) => x.item.id === ev.itemId);
      if (!existing) return state;
      return { ...state, live: { ...state.live, items: upsertItem(state.live.items, { ...existing, progress: ev.message }) } };
    }
    case 'item_completed': {
      const live = state.live ?? emptyLive('', ev.turnId, '');
      return { ...state, live: { ...live, items: upsertItem(live.items, { item: ev.item, done: true, media: ev.media }) } };
    }
    case 'plan':
      return state.live ? { ...state, live: { ...state.live, plan: { explanation: ev.explanation, steps: ev.steps } } } : state;
    case 'diff':
      return state.live ? { ...state, live: { ...state.live, diff: ev.diff } } : state;
    case 'usage':
      return state.live ? { ...state, live: { ...state.live, usage: ev.usage } } : state;
    case 'status':
      return state.live ? { ...state, live: { ...state.live, statusMessage: ev.message } } : state;
    case 'approval_requested':
      return state.approvals.some((a) => a.id === ev.approval.id) ? state : { ...state, approvals: [...state.approvals, ev.approval] };
    case 'approval_resolved':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== ev.approvalId) };
    case 'question_requested':
      return state.questions.some((q) => q.id === ev.question.id) ? state : { ...state, questions: [...state.questions, ev.question] };
    case 'question_resolved':
      return { ...state, questions: state.questions.filter((q) => q.id !== ev.questionId) };
    case 'goal_updated':
      return { ...state, goal: ev.goal };
    case 'queue_updated':
      return { ...state, queue: { queue: ev.queue, paused: ev.paused } };
    case 'auto_review': {
      const rest = state.reviews.filter((r) => r.reviewId !== ev.review.reviewId);
      return { ...state, reviews: [...rest, ev.review] };
    }
    default:
      return state;
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'history': {
      const clear = action.clearLive !== undefined && state.live && (state.live.requestId === action.clearLive || state.live.requestId === '');
      return {
        ...state,
        entries: action.entries,
        hasMore: action.hasMore,
        loaded: true,
        error: null,
        live: clear ? null : state.live,
        reviews: clear ? [] : state.reviews,
      };
    }
    case 'older':
      return { ...state, entries: [...action.entries, ...state.entries], hasMore: action.hasMore };
    case 'error':
      return { ...state, error: action.error, loaded: true };
    case 'connected':
      return { ...state, connected: action.value };
    case 'optimistic':
      return state.live ? state : { ...state, live: emptyLive(action.requestId, action.turnId, action.prompt, action.kind) };
    case 'steer':
      return state.live ? { ...state, live: { ...state.live, steers: [...state.live.steers, action.text] } } : state;
    case 'events':
      return action.events.reduce(applyEvent, state);
  }
}

const PAGE = 300;

const EVENT_TYPES: Array<ServerEvent['type']> = [
  'snapshot', 'turn_started', 'item_started', 'item_delta', 'item_progress', 'item_completed', 'plan', 'diff', 'usage', 'status',
  'approval_requested', 'approval_resolved', 'question_requested', 'question_resolved', 'goal_updated', 'transcript_changed',
  'queue_updated', 'auto_review', 'turn_completed', 'session_updated',
];

/** History from the API plus the live SSE stream for one session. */
export function useSessionStream(sessionId: string | null, onSessionUpdated: (s: SessionInfo) => void) {
  const [state, dispatch] = useReducer(reducer, initial);
  const queue = useRef<ServerEvent[]>([]);
  const frame = useRef<number | null>(null);
  const onUpdated = useRef(onSessionUpdated);
  onUpdated.current = onSessionUpdated;

  const loadHistory = useCallback(
    async (clearLive?: string) => {
      if (!sessionId) return;
      try {
        const res = await get<{ entries: TranscriptEntry[]; hasMore: boolean }>(`/api/sessions/${sessionId}/history${qs({ limit: PAGE })}`);
        dispatch({ type: 'history', entries: res.entries, hasMore: res.hasMore, clearLive });
      } catch (err) {
        dispatch({ type: 'error', error: err });
      }
    },
    [sessionId],
  );

  const loadOlder = useCallback(async () => {
    if (!sessionId || state.entries.length === 0) return;
    const res = await get<{ entries: TranscriptEntry[]; hasMore: boolean }>(`/api/sessions/${sessionId}/history${qs({ limit: PAGE, before: state.entries[0]!.id })}`);
    dispatch({ type: 'older', entries: res.entries, hasMore: res.hasMore });
  }, [sessionId, state.entries]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!sessionId) return;
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let snapshots = 0;
    void loadHistory();

    const flush = () => {
      frame.current = null;
      const events = queue.current.splice(0);
      if (events.length) dispatch({ type: 'events', events });
    };
    const enqueue = (ev: ServerEvent) => {
      queue.current.push(ev);
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };

    const connect = () => {
      source = new EventSource(`/api/sessions/${sessionId}/events`);
      const handle = (e: MessageEvent<string>) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (ev.type === 'snapshot') {
          dispatch({ type: 'connected', value: true });
          // After a reconnect, anything that finished while we were away is in history.
          if (snapshots++ > 0) void loadHistory();
        }
        if (ev.type === 'session_updated') onUpdated.current(ev.session);
        if (ev.type === 'turn_completed') {
          flush();
          void loadHistory(ev.requestId);
          return;
        }
        // Undo / fork rewrote the stored transcript.
        if (ev.type === 'transcript_changed') {
          void loadHistory();
          return;
        }
        enqueue(ev);
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.onerror = () => {
        dispatch({ type: 'connected', value: false });
        if (source?.readyState === EventSource.CLOSED && !closed) {
          // Closed for good (e.g. 401): re-check auth, then try again later.
          authEvents.dispatchEvent(new Event('lost'));
          retry = setTimeout(connect, 5000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      queue.current = [];
    };
  }, [sessionId, loadHistory]);

  const optimistic = useCallback(
    (requestId: string, turnId: string | null, prompt: string, kind: TurnKind = 'prompt') => dispatch({ type: 'optimistic', requestId, turnId, prompt, kind }),
    [],
  );
  const addSteer = useCallback((text: string) => dispatch({ type: 'steer', text }), []);

  return { ...state, loadOlder, reload: loadHistory, optimistic, addSteer };
}
