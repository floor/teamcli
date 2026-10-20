import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';

function manifest(): { version: string; description: string; license: string; homepage: string } {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(text) as { version: string; description: string; license: string; homepage: string };
}

// The one place the CLI's version is read. `--version` prints it and `team init` pins the
// schema URL's tag to it, so the URL can never name a release the CLI doesn't report.
export function version(): string {
  return manifest().version;
}

// The one place the CLI's opening sentence is read: `--help` prints it first, and
// scripts/check-readmes.ts holds it against the READMEs' first lines and the description
// itself, so the places cannot drift apart.
export function description(): string {
  return manifest().description;
}

export function license(): string {
  return manifest().license;
}

export function homepage(): string {
  return manifest().homepage;
}

/** The build a process is running: its version and a short digest of the entry module it
 *  loaded, so an inbox listener can say which code is serving a seat and a sender can tell a
 *  runtime started from another build from this one. `builtAt` is the entry file's mtime, the
 *  closest this build has to an install time; it is used only for a listener marker that
 *  records no identity of its own. */
export type BuildIdentity = { version: string; build: string | null; builtAt: number };

export function buildIdentity(argv: readonly string[] = process.argv): BuildIdentity {
  const entry = typeof argv[1] === 'string' ? argv[1] : '';
  let build: string | null = null;
  let builtAt = 0;
  try {
    const real = realpathSync(entry);
    build = createHash('sha256').update(readFileSync(real)).digest('hex').slice(0, 16);
    builtAt = statSync(real).mtimeMs;
  } catch {
    // An entry that cannot be read records the version alone; the marker says so by absence.
  }
  return { version: version(), build, builtAt };
}
