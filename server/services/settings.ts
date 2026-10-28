import type { AdminSettings } from '../../shared/api.js';
import type { Db } from '../db/db.js';

/** Owner-editable settings stored in the database, defaulting to the env config. */
export class SettingsStore {
  private cache: AdminSettings;

  constructor(
    private readonly db: Db,
    private readonly defaults: AdminSettings,
  ) {
    this.cache = this.load();
  }

  private load(): AdminSettings {
    const out: AdminSettings = { ...this.defaults };
    const target = out as unknown as Record<string, unknown>;
    for (const row of this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      if (!(row.key in out)) continue;
      const v = JSON.parse(row.value) as unknown;
      // Only accept a stored value of the same type as the default.
      if (typeof v === typeof target[row.key] && (typeof v !== 'number' || Number.isFinite(v))) target[row.key] = v;
    }
    return out;
  }

  get(): AdminSettings {
    return { ...this.cache };
  }

  update(patch: Partial<AdminSettings>): AdminSettings {
    this.db.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
      }
    });
    this.cache = this.load();
    return this.get();
  }
}
