import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version from this project's package.json (works from source and from dist/). */
export function appVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'codex-console') return pkg.version ?? '0.0.0';
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}
