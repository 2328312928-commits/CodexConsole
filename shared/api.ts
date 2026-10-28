import type { AskForApproval, FileUpdateChange, RateLimitSnapshot, SandboxMode, ThreadItem, TokenUsageBreakdown, TurnPlanStep } from './codex.js';

export const SECURITY_EVENT_KINDS = [
  'setup_completed',
  'pair_success',
  'pair_failure',
  'login_success',
  'login_failure',
  'login_locked',
  'admin_verify_success',
  'admin_verify_failure',
  'logout',
  'device_created',
  'device_renamed',
  'device_expiry_changed',
  'device_revoked',
  'device_pairing_code',
  'revoked_device_used',
  'expired_device_used',
  'rate_limited',
  'host_rejected',
  'origin_rejected',
  'login_session_revoked',
  'sessions_revoked',
  'settings_changed',
  'approval_decided',
  'approval_timed_out',
  'api_key_created',
  'api_key_updated',
  'api_key_rotated',
  'api_key_revoked',
  'api_key_rejected',
  'mcp_server_added',
  'mcp_server_updated',
  'mcp_server_removed',
  'mcp_login_started',
  'shell_command',
  'codex_config_changed',
  'codex_login_started',
  'codex_logout',
  'codex_features_changed',
  'plugin_installed',
  'plugin_uninstalled',
  'memory_reset',
  'agent_config_imported',
  'feedback_sent',
  'limit_reset_used',
] as const;
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

/** Events that may mean someone other than the owner is trying to get in. */
export const SECURITY_ALERT_KINDS: readonly SecurityEventKind[] = [
  'pair_failure',
  'login_failure',
  'login_locked',
  'admin_verify_failure',
  'revoked_device_used',
  'expired_device_used',
  'rate_limited',
  'host_rejected',
  'origin_rejected',
  'api_key_rejected',
];

export const REQUEST_STATUSES = [
  'running',
  'completed',
  'interrupted',
  'failed',
  'usage_limited',
  'rate_limited',
  'rejected',
  'quota_exceeded',
  'error',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const CODEX_STATES = ['starting', 'ready', 'restarting', 'failed', 'stopped'] as const;
export type CodexState = (typeof CODEX_STATES)[number];

/**
 * How an approval is answered. `acceptAlways` also saves Codex's proposed rule for similar commands;
 * `applyNetworkRule` applies one of its proposed network rules; `cancel` declines and stops the turn.
 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'applyNetworkRule' | 'decline' | 'cancel';
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['accept', 'acceptForSession', 'acceptAlways', 'applyNetworkRule', 'decline', 'cancel'];
/** Decisions that never widen what Codex may do. */
export const SAFE_APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['decline', 'cancel'];
export type ApprovalKind = 'command' | 'fileChange' | 'permissions';

export interface AuthState {
  setupComplete: boolean;
  device: { id: string; name: string } | null;
  loggedIn: boolean;
  admin: boolean;
}

export interface CodexStatusInfo {
  state: CodexState;
  version: string | null;
  testedVersion: string;
  versionMismatch: boolean;
  signedIn: boolean;
  account: { type: string; planType?: string | null; email?: string | null } | null;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot>;
  rateLimitsAt: number | null;
  lastError: string | null;
  restarts: number;
  sandbox: string;
  approvalPolicy: string;
  networkAccess: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string;
  efforts: string[];
  /** Codex's own description of each reasoning level for this model. */
  effortOptions: Array<{ effort: string; description: string }>;
  /** Optional speed tiers (e.g. `priority` = fast). */
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  inputModalities: string[];
}

export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];
export const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live'] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];
/** Who answers approval requests: you, or Codex's automatic reviewer. */
export type ApprovalsReviewer = 'user' | 'auto_review';
export type CollaborationModeKind = 'default' | 'plan';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  /** Path relative to the workspace root, or null when the folder is outside it. */
  workspacePath: string | null;
  threadId: string | null;
  model: string | null;
  effort: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  imported: boolean;
  running: boolean;
  /** Per-session overrides; null means "use the default". */
  settings: SessionSettings;
  forkedFrom: string | null;
  apiKey: { id: string; label: string } | null;
}

export interface SessionSettings {
  model: string | null;
  effort: string | null;
  summary: ReasoningSummary | null;
  /** Speed tier id from the model (e.g. `priority`); null = standard. */
  serviceTier: string | null;
  mode: CollaborationModeKind | null;
  sandbox: SandboxMode | null;
  approvalPolicy: AskForApproval | null;
  approvalsReviewer: ApprovalsReviewer | null;
  networkAccess: boolean | null;
  webSearch: WebSearchMode | null;
  /** Extra writable folders (workspace-relative), like `codex --add-dir`. */
  writableRoots: string[] | null;
  memory: boolean | null;
}

/** What a turn will actually run with once defaults and caps are applied. */
export interface EffectiveSettings {
  model: string | null;
  effort: string | null;
  summary: ReasoningSummary | null;
  serviceTier: string | null;
  mode: CollaborationModeKind;
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  networkAccess: boolean;
  webSearch: WebSearchMode | null;
  /** Absolute paths. */
  writableRoots: string[];
  memory: boolean | null;
}

export interface MediaRef {
  kind: 'image' | 'video' | 'audio';
  source: 'workspace' | 'store';
  /** Workspace-relative path, or the media-store file name. */
  path: string;
  name: string;
  mime: string;
  size: number | null;
}

export interface TranscriptEntry {
  id: number;
  requestId: string | null;
  turnId: string | null;
  kind: string;
  data: any;
  createdAt: number;
}

export interface ApprovalInfo {
  id: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  kind: ApprovalKind;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  grantRoot: string | null;
  permissions: unknown;
  changes: FileUpdateChange[] | null;
  /** Command prefix Codex proposes to always allow (for `acceptAlways`). */
  proposedRule: string[] | null;
  /** Network rules Codex proposes (for `applyNetworkRule`). */
  networkRules: Array<{ action: string; host: string }> | null;
  createdAt: number;
  expiresAt: number;
}

export interface LiveItem {
  item: ThreadItem;
  done: boolean;
  media: MediaRef[];
  /** Latest progress message (MCP tool calls). */
  progress?: string | null;
}

/** `auto`: a turn Codex started by itself, e.g. to keep working on a thread goal. */
export type TurnKind = 'prompt' | 'review' | 'compact' | 'shell' | 'auto';

/** A prompt waiting to run after the current turn. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachmentCount: number;
  createdAt: number;
}

/** Codex's automatic reviewer looking at an approval request. */
export interface AutoReview {
  reviewId: string;
  turnId: string | null;
  status: 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted';
  riskLevel: string | null;
  rationale: string | null;
  action: string;
}

export interface BackgroundTerminal {
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}

export interface SavedPrompt {
  name: string;
  description: string;
  content: string;
}

export interface ActiveTurnSnapshot {
  requestId: string;
  kind: TurnKind;
  turnId: string | null;
  startedAt: number;
  prompt: string;
  items: LiveItem[];
  plan: { explanation: string | null; steps: TurnPlanStep[] } | null;
  diff: string | null;
  approvals: ApprovalInfo[];
  questions: PendingQuestion[];
  reviews: AutoReview[];
  statusMessage: string | null;
  usage: TokenUsageBreakdown | null;
}

export interface TurnEndData {
  status: RequestStatus;
  error: string | null;
  durationMs: number | null;
  usage: TokenUsageBreakdown | null;
  model: string | null;
  kind?: TurnKind;
  /** The turn's combined diff, when Codex reported one. */
  diff?: string | null;
}

export type ServerEvent =
  | { type: 'snapshot'; turn: ActiveTurnSnapshot | null }
  | { type: 'turn_started'; requestId: string; turnId: string | null; prompt: string; startedAt: number; kind: TurnKind }
  | { type: 'item_started'; turnId: string; item: ThreadItem }
  | { type: 'item_delta'; turnId: string; itemId: string; field: 'text' | 'summary' | 'output' | 'content'; index?: number; delta: string }
  | { type: 'item_completed'; turnId: string; item: ThreadItem; media: MediaRef[] }
  | { type: 'plan'; turnId: string; explanation: string | null; steps: TurnPlanStep[] }
  | { type: 'diff'; turnId: string; diff: string }
  | { type: 'usage'; turnId: string; usage: TokenUsageBreakdown }
  | { type: 'status'; turnId: string | null; message: string | null }
  | { type: 'approval_requested'; approval: ApprovalInfo }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalDecision | 'timeout' | 'cancelled' }
  | { type: 'turn_completed'; requestId: string; turnId: string | null; end: TurnEndData; media: MediaRef[] }
  | { type: 'session_updated'; session: SessionInfo }
  | { type: 'question_requested'; question: PendingQuestion }
  | { type: 'question_resolved'; questionId: string; outcome: 'answered' | 'declined' | 'timeout' | 'cancelled' }
  | { type: 'item_progress'; turnId: string; itemId: string; message: string }
  | { type: 'goal_updated'; goal: ThreadGoal | null }
  | { type: 'transcript_changed' }
  | { type: 'queue_updated'; queue: QueuedPrompt[]; paused: boolean }
  | { type: 'auto_review'; review: AutoReview };

export interface ThreadGoal {
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

/** Codex asking for input: its own clarifying questions, or an MCP server's form or link. */
export interface PendingQuestion {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: 'input' | 'elicitation';
  questions: UserInputQuestion[] | null;
  server: string | null;
  message: string | null;
  mode: 'form' | 'url' | null;
  schema: unknown;
  url: string | null;
  createdAt: number;
  expiresAt: number;
}

export type QuestionAnswer =
  | { kind: 'input'; answers: Record<string, string[]> }
  | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number | null;
  mtime: number | null;
  mime: string | null;
  media: 'image' | 'video' | 'audio' | null;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  insideWorkspace: boolean;
}

// ---- admin ----

export type DeviceStatus = 'pending' | 'active' | 'expired' | 'revoked';

export interface DeviceInfo {
  id: string;
  name: string;
  status: DeviceStatus;
  tokenHint: string | null;
  createdAt: number;
  pairedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  lastIp: string | null;
  lastUserAgent: string | null;
  usage: DeviceUsage;
}

export interface DeviceUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  uploads: number;
  uploadBytes: number;
  downloads: number;
  downloadBytes: number;
  apiCalls: number;
}

export interface PairingInfo {
  device: DeviceInfo;
  code: string;
  expiresAt: number;
  pairUrl: string;
  qrSvg: string;
}

export interface RequestRow {
  id: string;
  kind: string;
  sessionId: string;
  sessionTitle: string | null;
  deviceId: string | null;
  deviceName: string | null;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  status: RequestStatus;
  promptChars: number;
  promptBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  mediaCount: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  model: string | null;
  error: string | null;
  ip: string | null;
}

export interface FileTransferRow {
  id: number;
  at: number;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  deviceId: string | null;
  deviceName: string | null;
  sessionId: string | null;
  direction: 'upload' | 'download' | 'view';
  path: string;
  bytes: number;
  ok: boolean;
}

export interface SecurityEventRow {
  id: number;
  at: number;
  kind: SecurityEventKind;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  deviceId: string | null;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

export interface LoginSessionInfo {
  id: string;
  deviceId: string;
  deviceName: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  admin: boolean;
  current: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface AdminOverview {
  codex: CodexStatusInfo;
  publicApi: { enabled: boolean; baseUrl: string; listen: string; proxyProtocol: string; activeKeys: number; requests24h: number };
  totals: {
    requests24h: number;
    requests7d: number;
    tokens24h: { input: number; output: number };
    tokens7d: { input: number; output: number };
    failed7d: number;
    uploadBytes7d: number;
    downloadBytes7d: number;
    activeDevices: number;
    securityEvents24h: number;
  };
  daily: Array<{ day: string; requests: number; inputTokens: number; outputTokens: number; failed: number }>;
  limitHistory: Array<{ at: number; primary: number | null; secondary: number | null }>;
}

export interface AdminSettings {
  logRetentionDays: number;
  approvalTimeoutSec: number;
  /** Console-wide session defaults (each session can override them). */
  defaultSandbox: SandboxMode;
  defaultApprovalPolicy: AskForApproval;
  defaultNetworkAccess: boolean;
}

export interface SessionStatus {
  session: SessionInfo;
  effective: EffectiveSettings;
  contextWindow: number | null;
  totalTokens: { input: number; cachedInput: number; output: number; reasoning: number } | null;
  lastTurnTokens: TokenUsageBreakdown | null;
  goal: ThreadGoal | null;
  rateLimits: RateLimitSnapshot | null;
  pendingApprovals: number;
  pendingQuestions: number;
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
}

/** Result of a slash command (console composer or POST …/command). */
export type CommandResult =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'turn'; requestId: string; turnId: string | null }
  | { kind: 'settings'; session: SessionInfo; effective: EffectiveSettings }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'diff'; turnDiff: string | null; gitDiff: string | null; gitError: string | null }
  | { kind: 'skills'; skills: SkillInfo[] }
  | { kind: 'models'; models: ModelInfo[]; current: string | null }
  | { kind: 'mcp'; servers: McpServerView[] }
  | { kind: 'goal'; goal: ThreadGoal | null }
  | { kind: 'help'; commands: Array<{ name: string; args: string }> }
  | { kind: 'terminals'; terminals: BackgroundTerminal[] }
  | { kind: 'info'; text: string }
  | { kind: 'done' };

// ---- API keys ----

export const API_KEY_SCOPES = ['prompt', 'sessions', 'files:read', 'files:write', 'approvals', 'settings', 'mcp:read', 'mcp:manage', 'shell'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
/** Scopes that reach outside Codex's sandbox; off unless explicitly granted. */
export const DANGEROUS_SCOPES: readonly ApiKeyScope[] = ['mcp:manage', 'shell'];
export const QUOTA_PERIODS = ['day', 'month', 'total'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];
export type KeyApprovals = 'deny' | 'ask';
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyLimits {
  perMinute: number;
  promptsPerMinute: number;
  concurrent: number;
  uploadMbPerHour: number;
}

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** Recognisable but useless form, e.g. cck_0123abcd….wxyz */
  display: string;
  status: ApiKeyStatus;
  scopes: ApiKeyScope[];
  folder: string;
  quota: { tokens: number | null; period: QuotaPeriod; used: number; resetsAt: number | null };
  maxSandbox: SandboxMode;
  allowNetwork: boolean;
  approvals: KeyApprovals;
  limits: ApiKeyLimits;
  ipAllowlist: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  rotatedAt: number | null;
  graceUntil: number | null;
  lastUsedAt: number | null;
  lastIp: string | null;
  usage30d: { requests: number; inputTokens: number; outputTokens: number; failed: number; uploadBytes: number; downloadBytes: number; apiCalls: number };
}

export interface ApiKeySecret {
  key: ApiKeyInfo;
  /** Shown exactly once. */
  secret: string;
  baseUrl: string;
}

export interface ApiKeyUsage {
  key: ApiKeyInfo;
  daily: Array<{ day: string; requests: number; tokens: number; failed: number }>;
  recent: RequestRow[];
}

/** The result of one prompt, as returned by the public API. */
export interface TurnResult {
  requestId: string;
  sessionId: string;
  turnId: string | null;
  status: RequestStatus;
  error: string | null;
  text: string | null;
  durationMs: number | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  files: Array<{ path: string; kind: string }>;
  media: MediaRef[];
  commands: Array<{ command: string; exitCode: number | null; status: string }>;
  diff: string | null;
  pendingApprovals: ApprovalInfo[];
  pendingQuestions: PendingQuestion[];
}

// ---- MCP ----

export interface McpServerInput {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string | null;
  /** Values are write-only: listing returns only the variable names. Omit a value to keep it. */
  env?: Record<string, string | null>;
  url?: string;
  bearerTokenEnvVar?: string | null;
  enabled?: boolean;
  enabledTools?: string[] | null;
  disabledTools?: string[] | null;
  startupTimeoutSec?: number | null;
  toolTimeoutSec?: number | null;
}

export interface McpServerView {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  cwd: string | null;
  envKeys: string[];
  url: string | null;
  bearerTokenEnvVar: string | null;
  enabledTools: string[] | null;
  disabledTools: string[] | null;
  startupTimeoutSec: number | null;
  toolTimeoutSec: number | null;
  runtimeStatus: string | null;
  authStatus: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: Array<{ name: string; description: string | null }>;
  resourceCount: number;
  error: string | null;
}

export interface CodexDefaults {
  model: string | null;
  effort: string | null;
}

export interface ConsoleDefaults {
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  networkAccess: boolean;
}
