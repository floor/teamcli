import { homedir } from 'node:os';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [expectedHome, encoded] = process.argv.slice(2);
if (!expectedHome || !encoded || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const { watchStopRead } = await import('../../src/watch/pane.ts');
const input = JSON.parse(encoded) as { words?: string[]; cwd?: string; session?: string; alive?: boolean; startOffset?: number; noStart?: boolean; pane?: boolean; epoch?: boolean; noExpectedFile?: boolean; otherEntry?: boolean };
const base = dirname(homedir());
const a = join(base, 'alpha team');
const b = join(base, 'beta team');
for (const root of [a, b]) { mkdirSync(join(root, '.agents'), { recursive: true }); writeFileSync(join(root, '.agents', 'team.yaml'), 'format: 1\n'); }
const alias = join(base, 'alpha alias');
symlinkSync(a, alias, 'dir');
const fakeEntry = join(base, 'foreign-cli.js');
writeFileSync(fakeEntry, '// synthetic foreign entry\n');
const substitutions: Record<string, string> = { A_FILE: join(a, '.agents', 'team.yaml'), B_FILE: join(b, '.agents', 'team.yaml'), ALIAS_FILE: join(alias, '.agents', 'team.yaml'), A_ROOT: a, A_DIR: join(a, '.agents'), B_ROOT: b, ALIAS_ROOT: alias };
const replace = (word: string) => word.replace(/\$([A-Z_]+)/g, (_all, key: string) => substitutions[key] ?? key);
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const entry = input.otherEntry ? fakeEntry : fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const command = [process.execPath, entry, 'watch', ...(input.words ?? ['--session', 'shared'])].map((word) => quote(replace(word))).join(' ');
const started = Date.now();
const pid = 424242;
const record = { pid, ...(input.noStart ? {} : { started_at: new Date(started).toISOString() }), ...(input.pane ? { pane: 'synthetic-watch-pane' } : {}), ...(input.epoch ? { epoch: `watch_${'a'.repeat(32)}` } : {}) };
const reads: string[] = [];
const result = watchStopRead(record, input.session ?? 'shared', {
  alive: (seen) => { if (seen !== pid) throw new Error('wrong synthetic pid'); reads.push('alive'); return input.alive ?? true; },
  commandOf: () => { reads.push('command'); return command; },
  startOf: () => { reads.push('start'); return started + (input.startOffset ?? 0); },
  cwdOf: () => { reads.push('working-folder-adapter'); return input.cwd === 'missing' ? null : replace(input.cwd ?? '$A_ROOT'); },
}, { file: input.noExpectedFile ? null : realpathSync(join(a, '.agents', 'team.yaml')), dirs: [realpathSync(a), realpathSync(join(a, '.agents'))] });
console.log(JSON.stringify({ home: homedir(), result, reads }));
