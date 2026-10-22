import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';

function manifest(): { version: string; description: string; license: string; homepage: string; gitHead?: string } {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(text) as { version: string; description: string; license: string; homepage: string; gitHead?: string };
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

/** The commit a packed package was built from: `scripts/pack.ts` writes the checkout's full
 *  git head into the packed manifest, and `scripts/install.ts` verifies it. A source checkout has
 *  no such field, so its identity has no packaged head. */
export function packagedHead(): string | null {
  const written = manifest().gitHead;
  return typeof written === 'string' && /^[0-9a-f]{40}$/.test(written) ? written : null;
}

/** The install a process is running: the version its manifest names and the packed commit, when
 *  it has one. A running process compares this with the identity on disk to notice an install
 *  that landed under it; the entry digest is not part of the comparison because a rebuild of the
 *  same version and commit is the same install. */
export type InstallIdentity = { version: string; head: string | null };

export function installIdentity(): InstallIdentity {
  return { version: version(), head: packagedHead() };
}

/** The build a process is running: its version, the packed commit when the package carries one,
 *  and a short digest of the entry module it loaded, so an inbox listener can say which code is
 *  serving a seat and a sender can tell a runtime started from another build from this one.
 *  `builtAt` is the entry file's mtime, the closest this build has to an install time; it is used
 *  only for a listener marker that records no identity of its own. */
export type BuildIdentity = { version: string; build: string | null; builtAt: number; head: string | null };

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
  return { version: version(), build, builtAt, head: packagedHead() };
}
