// Owner-written script-to-declaration choices for launcher migration. The map lives outside
// repositories; migration reads it but never writes it or reads the named scripts' contents.
import { isAbsolute, join, resolve } from 'node:path';
import { readOwnedText } from './owned-text.ts';

export type LauncherMigrations =
  | { ok: true; scripts: ReadonlyMap<string, string> }
  | { ok: false; why: string };

/** The owner-written mapping file, outside every project. */
export function launcherMigrationsPath(home: string): string {
  return join(home, '.config', 'team', 'launcher-migrations.json');
}

/** Exact absolute script paths mapped to existing launcher declaration names. A missing map
 *  is empty. An unreadable or unsafe map refuses instead of choosing a declaration. */
export function readLauncherMigrations(home: string): LauncherMigrations {
  const read = readOwnedText(launcherMigrationsPath(home), home);
  if (read.kind === 'missing') return { ok: true, scripts: new Map() };
  if (read.kind === 'refused') return { ok: false, why: `the local launcher migration map was refused: ${read.reason}` };
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return { ok: false, why: 'the local launcher migration map must hold valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, why: 'the local launcher migration map must be an object' };
  }
  const record = value as Record<string, unknown>;
  if (record.format !== 1 || Object.keys(record).some((key) => key !== 'format' && key !== 'scripts')) {
    return { ok: false, why: 'the local launcher migration map needs format 1 and scripts only' };
  }
  if (record.scripts === null || typeof record.scripts !== 'object' || Array.isArray(record.scripts)) {
    return { ok: false, why: 'the local launcher migration map needs a scripts object' };
  }
  const scripts = new Map<string, string>();
  for (const [script, launcher] of Object.entries(record.scripts)) {
    if (!isAbsolute(script) || script.includes('\0') || typeof launcher !== 'string' || launcher === '') {
      return { ok: false, why: 'each local launcher migration needs an absolute script path and a declaration name' };
    }
    const absolute = resolve(script);
    if (scripts.has(absolute)) return { ok: false, why: 'the local launcher migration map names one script more than once' };
    scripts.set(absolute, launcher);
  }
  return { ok: true, scripts };
}
