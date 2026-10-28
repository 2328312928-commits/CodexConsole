// Append-only: never edit a migration that has shipped; add a new one.
// All timestamps are milliseconds since the Unix epoch.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT NOT NULL,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    token_hint TEXT,
    created_at INTEGER NOT NULL,
    paired_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER,
    last_ip TEXT,
    last_user_agent TEXT
  );

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE login_sessions (
    id TEXT PRIMARY KEY,
    id_hash TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    admin_verified_at INTEGER,
    admin_seen_at INTEGER,
    ip TEXT,
    user_agent TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX login_sessions_device ON login_sessions(device_id);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    thread_id TEXT UNIQUE,
    title TEXT NOT NULL,
    title_auto INTEGER NOT NULL DEFAULT 1,
    cwd TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    created_by_device TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    synced_turns INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_updated ON sessions(updated_at);

  CREATE TABLE transcript (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    request_id TEXT,
    turn_id TEXT,
    item_id TEXT,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX transcript_session ON transcript(session_id, id);
  CREATE UNIQUE INDEX transcript_item ON transcript(session_id, turn_id, item_id) WHERE item_id IS NOT NULL;

  -- One row per prompt sent to Codex. Kept after a session is deleted (audit).
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    session_title TEXT,
    device_id TEXT,
    thread_id TEXT,
    turn_id TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    prompt_chars INTEGER NOT NULL,
    prompt_bytes INTEGER NOT NULL,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    attachment_bytes INTEGER NOT NULL DEFAULT 0,
    media_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    model TEXT,
    effort TEXT,
    error TEXT,
    ip TEXT
  );
  CREATE INDEX requests_started ON requests(started_at);
  CREATE INDEX requests_device ON requests(device_id, started_at);
  CREATE INDEX requests_session ON requests(session_id, started_at);

  CREATE TABLE file_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    device_id TEXT,
    session_id TEXT,
    direction TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX file_transfers_at ON file_transfers(at);
  CREATE INDEX file_transfers_device ON file_transfers(device_id, at);

  CREATE TABLE api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    device_id TEXT,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    bytes_in INTEGER,
    bytes_out INTEGER,
    ip TEXT
  );
  CREATE INDEX api_log_at ON api_log(at);
  CREATE INDEX api_log_device ON api_log(device_id, at);

  CREATE TABLE security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    device_id TEXT,
    ip TEXT,
    user_agent TEXT,
    detail TEXT
  );
  CREATE INDEX security_events_at ON security_events(at);

  CREATE TABLE rate_limit_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX rate_limit_snapshots_at ON rate_limit_snapshots(at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: API keys for the public API, per-session Codex settings, key attribution in every log.
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    secret_hint TEXT NOT NULL,
    prev_secret_hash TEXT,
    prev_valid_until INTEGER,
    scopes TEXT NOT NULL,
    folder TEXT NOT NULL,
    quota_tokens INTEGER,
    quota_period TEXT NOT NULL,
    max_sandbox TEXT NOT NULL,
    allow_network INTEGER NOT NULL DEFAULT 0,
    approvals TEXT NOT NULL,
    rate_per_min INTEGER NOT NULL,
    prompts_per_min INTEGER NOT NULL,
    max_concurrent INTEGER NOT NULL,
    upload_mb_per_hour INTEGER NOT NULL,
    ip_allowlist TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    rotated_at INTEGER,
    last_used_at INTEGER,
    last_ip TEXT
  );

  ALTER TABLE sessions ADD COLUMN api_key_id TEXT;
  ALTER TABLE sessions ADD COLUMN sandbox TEXT;
  ALTER TABLE sessions ADD COLUMN approval_policy TEXT;
  ALTER TABLE sessions ADD COLUMN network INTEGER;
  ALTER TABLE sessions ADD COLUMN forked_from TEXT;
  CREATE INDEX sessions_key ON sessions(api_key_id);

  ALTER TABLE requests ADD COLUMN api_key_id TEXT;
  ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
  CREATE INDEX requests_key ON requests(api_key_id, started_at);

  ALTER TABLE api_log ADD COLUMN api_key_id TEXT;
  CREATE INDEX api_log_key ON api_log(api_key_id, at);

  ALTER TABLE file_transfers ADD COLUMN api_key_id TEXT;
  ALTER TABLE security_events ADD COLUMN api_key_id TEXT;
  `,
  // v3: more per-session Codex settings (reasoning summary, speed, plan mode, reviewer, web search, extra folders, memory).
  `
  ALTER TABLE sessions ADD COLUMN extra_settings TEXT;
  `,
];
