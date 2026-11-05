// A fake `jules` executable for every scene that runs the session leg: it records the argv and
// folder of each call and answers from the scene's script, so no scene can create a real remote
// session. Its folder is put FIRST on PATH, and every scene asserts that order before it runs
// anything: a machine that has a real `jules` installed can still never be reached by name.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One call the fake saw, as the CLI itself saw it: the arguments after the binary, and the
 *  folder the call ran in. */
export type FakeJulesCall = { argv: string[]; cwd: string };

/** The script a scene gives the fake: what it writes on each stream and the status it exits with. */
export type FakeJulesAnswer = { status?: number; stdout?: string; stderr?: string };

export type FakeJules = {
  /** The executable's own path: what a first-on-PATH assertion compares against. */
  binary: string;
  /** Every call the fake answered, in the order they were made. */
  calls: () => FakeJulesCall[];
  /** The first `jules` on PATH right now, as `spawn` would find it. */
  firstOnPath: () => string | null;
};

/** The first `jules` a PATH walk finds — the rule a bare binary name follows. */
export function firstJulesOnPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'jules');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// The PATH every fake is installed in front of, captured before the first install. Two files may
// use the harness in one run, and a scene must hand PATH back exactly as it found it.
let originalPath: string | undefined;
let installed = false;
const created: string[] = [];

/** Installs one fake `jules` FIRST on PATH and returns it. `parent` is the folder the fake's own
 *  directory is made in (the scene's scratch folder, so its cleanup takes the fake too); absent,
 *  a folder of the harness's own. The caller asserts `firstOnPath() === binary`; the harness does
 *  not assert for it. */
export function fakeJulesOnPath(answer: FakeJulesAnswer = {}, parent?: string): FakeJules {
  const base = realpathSync(mkdtempSync(join(parent ?? tmpdir(), 'fake-jules-')));
  created.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const callsPath = join(base, 'calls.jsonl');
  const binary = join(bin, 'jules');
  const status = answer.status ?? 0;
  const stdout = answer.stdout ?? '';
  const stderr = answer.stderr ?? '';
  // The fake runs on the same runtime the suite runs on, so the shebang never depends on a
  // second interpreter being installed. Every argument is recorded verbatim — JSON keeps a
  // multi-line body one argument — and the response is the scene's, then the status.
  writeFileSync(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${String(status)});
`,
    { mode: 0o755 },
  );
  if (!installed) {
    originalPath = process.env.PATH;
    installed = true;
  }
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  return {
    binary,
    calls: () => {
      if (!existsSync(callsPath)) return [];
      return readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeJulesCall);
    },
    firstOnPath: firstJulesOnPath,
  };
}

/** Hands PATH back to the state the first install found and deletes every fake's folder. A test
 *  file calls this from its own `afterEach`; a scene must never leave its fake on PATH. */
export function cleanupFakeJules(): void {
  if (installed) {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    originalPath = undefined;
    installed = false;
  }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
