import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KnownHosts, Site } from './remote.js';

/** The server you used last, so the form is filled in next time. Never a password or a key. */
export interface SavedServer {
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key';
  /** A key file in ~/.ssh, by name. */
  keyName: string;
  mode: Site['mode'];
  domain: string;
  email: string;
}

interface State {
  lang?: Site['lang'];
  server?: SavedServer;
  /** "host:port" → the fingerprint you confirmed. */
  knownHosts: Record<string, string>;
}

export function configDir(): string {
  if (process.env.CODEX_CONSOLE_DEPLOY_HOME) return process.env.CODEX_CONSOLE_DEPLOY_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'CodexConsoleDeploy');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CodexConsoleDeploy');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'codex-console-deploy');
}

export class Store implements KnownHosts {
  private state: State = { knownHosts: {} };
  private readonly file: string;

  constructor(dir = configDir()) {
    this.file = path.join(dir, 'state.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
      this.state = { ...parsed, knownHosts: parsed.knownHosts ?? {} };
    } catch {
      // first run, or an unreadable file: start empty
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(hostPort: string): string | undefined {
    return this.state.knownHosts[hostPort];
  }

  trust(hostPort: string, fingerprint: string): void {
    this.state.knownHosts[hostPort] = fingerprint;
    this.save();
  }

  get server(): SavedServer | null {
    return this.state.server ?? null;
  }

  set server(server: SavedServer) {
    this.state.server = server;
    this.save();
  }

  get lang(): Site['lang'] | null {
    return this.state.lang ?? null;
  }

  set lang(lang: Site['lang']) {
    this.state.lang = lang;
    this.save();
  }
}
