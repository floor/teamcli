// Independent scenes for the trusted-path fix (identity tools): every helper that supplies
// process evidence resolves its tool from a fixed, platform-declared trusted set — never from
// the caller's PATH — spawns it by absolute path with a fresh allowlist env, and fails closed
// when the trusted tool is missing. The brief's attack is mounted for real in every scene: a
// shim directory first on PATH carries a fake ps, lsof and pgrep that log each run and would
// answer crafted evidence (an ancestry that places the caller, a folder, a running process).
// A scene proves the fence by the shim's log: not one line may appear. The trusted side is
// modeled by owned fixtures injected through the adapter seam (createProcessToolsAdapter);
// the production singleton is exercised against the real table in its own scene. The terminal
// host is out of scope for this fix.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readAncestors, placeCaller, readWithPs, type CallerSources } from '../src/caller.ts';
import { processComm } from '../src/commands/doctor.ts';
import { realSources } from '../src/commands/mcp.ts';
import { codexCommandOf } from '../src/launch/codex-endpoint.ts';
import {
  createProcessToolsAdapter,
  trustedProcessToolPath,
} from '../src/process-tools-adapter.ts';
import * as processTools from '../src/process-tools-adapter.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { processCommandOf } from '../src/watch/pane.ts';
import {
  parseProcessTable,
  processCommOf,
  processCpuTimeAsync,
  processFoldersOf,
  processStartOf,
  processWorkingFolderOf,
} from '../src/watch/process-adapter.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

type ProcessToolsAdapter = ReturnType<typeof createProcessToolsAdapter>;
type ExecToolOptions = Parameters<ProcessToolsAdapter['execSync']>[2];

// The crafted ancestry the shims would supply: the caller under a claude whose parent is a
// herdr pane root (SHIM_ROOT) — the chain that placed the unplaced seat in the live incident.
// Neither pid exists on this machine, so no real table can carry them.
const SHIM_ROOT = 700001;
const SHIM_SERVER = 700002;
const ATTACK_PANE = 'fixture-pane-shim';
const TRUSTED_PANE = 'fixture-pane-trusted';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(tag: string): string {
  const base = fixtureBase(`trusted-tools-${tag}-`);
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function toolScript(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function logLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
}

/** An owned fixture that stands for the platform's trusted tool. Every run appends one line to
 *  its log, so a scene can prove the trusted side answered as often as it claims. */
function trustedTool(tag: string, name: 'ps' | 'lsof' | 'pgrep', body: string): {
  path: string;
  runs: () => number;
} {
  const base = scratch(`trusted-${tag}`);
  const log = join(base, 'trusted-runs.log');
  const path = toolScript(join(base, 'bin'), name, `printf '%s\\n' ran >> '${log}'\n${body}`);
  return { path, runs: () => logLines(log).length };
}

/** Mounts the brief's attack: ps, lsof and pgrep shims, each logging every run and answering
 *  crafted evidence, first on PATH for everything `run` does. The log the scene asserts on. */
function mountedAttack<T>(tag: string, run: (world: { shimDir: string; shimRuns: () => string[] }) => T): T {
  const base = scratch(`attack-${tag}`);
  const shimLog = join(base, 'shim-runs.log');
  const shimDir = join(base, 'shim-bin');
  toolScript(shimDir, 'ps', `printf '%s\\n' ps >> '${shimLog}'\nprintf '%s ${SHIM_ROOT} claude\\n${SHIM_ROOT} ${SHIM_SERVER} herdr\\n${SHIM_SERVER} 1 launchd\\n' "$PPID"`);
  toolScript(shimDir, 'lsof', `printf '%s\\n' lsof >> '${shimLog}'\nprintf 'p4242\\nfcwd\\nn/attack/fixture-folder\\n'`);
  toolScript(shimDir, 'pgrep', `printf '%s\\n' pgrep >> '${shimLog}'\nexit 0`);
  const saved = process.env.PATH;
  process.env.PATH = saved === undefined ? shimDir : `${shimDir}:${saved}`;
  try {
    return run({ shimDir, shimRuns: () => logLines(shimLog) });
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

function over(tool: { path: string }): ProcessToolsAdapter {
  return createProcessToolsAdapter(
    { ps: [tool.path], lsof: [tool.path], pgrep: [tool.path] },
    (candidate) => candidate === tool.path,
  );
}

function unavailable(): ProcessToolsAdapter {
  return createProcessToolsAdapter({}, () => true);
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the adapter seam', () => {
  test('runs the trusted candidate; a shim first on PATH never runs', () => {
    mountedAttack('adapter-runs', ({ shimRuns }) => {
      const tool = trustedTool('adapter-runs', 'ps', "printf 'TRUSTED-ANSWER\\n'");
      const out = over(tool).execSync('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 });
      expect(out).toContain('TRUSTED-ANSWER');
      expect(tool.runs()).toBeGreaterThan(0);
      expect(shimRuns()).toEqual([]);
    });
  });

  test('a missing trusted tool fails closed with ENOENT and never falls back to PATH', () => {
    mountedAttack('adapter-closed', ({ shimRuns }) => {
      const tool = trustedTool('adapter-closed', 'lsof', 'exit 0');
      const adapter = createProcessToolsAdapter({ lsof: [tool.path] }, (candidate) => candidate === tool.path);
      const error = thrownBy(() => adapter.execSync('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 })) as NodeJS.ErrnoException;
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('ENOENT');
      expect(error.message).toContain('the trusted process tool ps is unavailable');
      expect(thrownBy(() => adapter.spawnSync('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 }))).toBeInstanceOf(Error);
      expect(thrownBy(() => adapter.exec('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 }, () => {}))).toBeInstanceOf(Error);
      // The shim answered nothing: resolution never consulted PATH, the one place it lives.
      expect(shimRuns()).toEqual([]);
      // An unsupported platform supplies no evidence path at all, and the fixed locations are
      // the platform's own system directories, not anything a caller or PATH names.
      expect(trustedProcessToolPath('ps', 'sunos')).toBe(null);
      expect(trustedProcessToolPath('pgrep', 'linux', () => true)).toBe('/usr/bin/pgrep');
    });
  });

  test('the trusted child sees only the allowlist env, cwd /, and its own arguments', () => {
    mountedAttack('adapter-env', ({ shimDir, shimRuns }) => {
      const base = scratch('dump');
      const dump = join(base, 'child-facts.txt');
      const tool = trustedTool('dump', 'ps',
        `printf 'LANG=%s\\nLC_ALL=%s\\nTZ=%s\\nPATH=%s\\nPROBE=%s\\nPWD=%s\\nZERO=%s\\nSTAR=%s\\n' "$LANG" "$LC_ALL" "$TZ" "\${PATH:-UNSET}" "\${TEAMCLI_PROBE_PARENT:-UNSET}" "$(pwd)" "$0" "$*" > '${dump}'`);
      const saved = process.env.TEAMCLI_PROBE_PARENT;
      process.env.TEAMCLI_PROBE_PARENT = 'parent-value';
      try {
        over(tool).execSync('ps', ['alpha', 'beta'], { encoding: 'utf8', timeout: 4_000 });
      } finally {
        if (saved === undefined) delete process.env.TEAMCLI_PROBE_PARENT;
        else process.env.TEAMCLI_PROBE_PARENT = saved;
      }
      const facts = Object.fromEntries(logLines(dump).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      // A fresh allowlist, not a filtered inheritance: the three fixed settings stand, the
      // parent's own probe value reaches nothing, and the caller's PATH — the shim dir first —
      // never arrives. (The child shell hands itself a compiled-in PATH default after exec,
      // measured here as /usr/gnu/bin:..., so the boundary is proven by what the caller tried
      // to pass, not by emptiness.)
      expect(facts.LANG).toBe('C');
      expect(facts.LC_ALL).toBe('C');
      expect(facts.TZ).toBe('UTC');
      expect(facts.PROBE).toBe('UNSET');
      expect(facts.PATH).not.toContain(shimDir);
      expect(facts.PWD).toBe('/');
      expect(facts.ZERO).toBe(tool.path);
      expect(facts.STAR).toBe('alpha beta');
      expect(shimRuns()).toEqual([]);
    });
  });

  test('caller options cannot widen the env or cwd boundary', () => {
    mountedAttack('adapter-options', ({ shimDir }) => {
      const base = scratch('dump-options');
      const dump = join(base, 'child-facts.txt');
      const tool = trustedTool('dump-options', 'ps',
        `printf 'PATH=%s\\nPROBE=%s\\nPWD=%s\\nSTAR=%s\\n' "\${PATH:-UNSET}" "\${TEAMCLI_PROBE_PARENT:-UNSET}" "$(pwd)" "$*" > '${dump}'`);
      // A caller that casts past the option type: the boundary values are re-fixed after the
      // caller's options, so neither its env (the attack shim dir first on PATH, and a probe
      // value) nor its cwd reaches the child.
      const widened = {
        env: { PATH: shimDir, TEAMCLI_PROBE_PARENT: 'override' },
        cwd: shimDir,
        shell: true,
        timeout: 4_000,
      } as unknown as ExecToolOptions;
      over(tool).execSync('ps', ['ov-one', 'ov-two'], widened);
      const facts = Object.fromEntries(logLines(dump).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      expect(facts.PROBE).toBe('UNSET');
      expect(facts.PATH).not.toContain(shimDir);
      expect(facts.PWD).toBe('/');
      expect(facts.STAR).toBe('ov-one ov-two');
    });
  });

  test('resolution takes the first usable candidate; none usable is unavailable', () => {
    mountedAttack('adapter-candidates', ({ shimRuns }) => {
      const tool = trustedTool('candidates', 'ps', "printf 'FIRST-USABLE\\n'");
      const absent = join(scratch('candidates'), 'bin', 'absent-ps');
      const adapter = createProcessToolsAdapter(
        { ps: [absent, tool.path] },
        (candidate) => existsSync(candidate),
      );
      expect(adapter.execSync('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 })).toContain('FIRST-USABLE');
      const noneUsable = createProcessToolsAdapter({ ps: [tool.path] }, () => false);
      const error = thrownBy(() => noneUsable.execSync('ps', ['-o', 'probe='], { encoding: 'utf8', timeout: 4_000 })) as NodeJS.ErrnoException;
      expect(error?.code).toBe('ENOENT');
      expect(shimRuns()).toEqual([]);
    });
  });
});

describe('the readers behind the seam', () => {
  const AGENTS: HerdrAgent[] = [
    { name: 'shim-seat', agent: 'claude', pane: ATTACK_PANE, workspace: 'floor', status: 'idle', cwd: null },
    { name: 'trusted-seat', agent: 'claude', pane: TRUSTED_PANE, workspace: 'floor', status: 'idle', cwd: null },
  ];

  /** The walk world: the shim pane's root is the crafted pid only the shim's table carries, the
   *  trusted pane's root is this process, which only the trusted table names as herdr-rooted. */
  function sources(ancestors: CallerSources['ancestors']): CallerSources {
    return {
      ancestors,
      agents: () => AGENTS,
      paneRootPid: (pane) => (pane === ATTACK_PANE ? SHIM_ROOT : pane === TRUSTED_PANE ? process.pid : null),
      env: { HERDR_PANE_ID: ATTACK_PANE },
      stdinIsTTY: false,
    };
  }

  test('the placement walk places from the trusted table while a live shim never runs', () => {
    mountedAttack('walk', ({ shimRuns }) => {
      // The attack is live for a bare-name spawn: with the shim first on PATH, a plain `ps`
      // child answers the crafted ancestry — the exact mechanism of the live incident.
      const bare = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
      expect(bare).toContain(`${SHIM_ROOT} ${SHIM_SERVER} herdr`);
      const attackMounted = shimRuns().length;
      expect(attackMounted).toBeGreaterThan(0);

      // Had the walk read that table, the hinted attack pane would come first among the agents
      // and its crafted root would be an ancestor: `shim-seat` would place. The trusted table
      // instead roots this process under herdr, so only the trusted pane's root is an ancestor.
      const tool = trustedTool('walk', 'ps', `printf '%s 1 herdr\\n' "$PPID"`);
      const spy = spyOn(processTools, 'execProcessToolSync').mockImplementation(over(tool).execSync);
      let placed: ReturnType<typeof placeCaller>;
      try {
        placed = placeCaller(sources(() => readAncestors(process.pid, readWithPs)), 'home-session');
      } finally {
        spy.mockRestore();
      }
      expect(placed).toEqual({ kind: 'seat', name: 'trusted-seat', pane: TRUSTED_PANE, session: 'home-session' });
      expect(tool.runs()).toBeGreaterThan(0);
      // Not one new shim run: the walk took its evidence from the trusted tool alone.
      expect(shimRuns()).toHaveLength(attackMounted);
    });
  });

  test('a missing trusted ps closes the walk: unplaced, diagnostic kept, no PATH fallback', () => {
    mountedAttack('walk-closed', ({ shimRuns }) => {
      const causes: string[] = [];
      const spy = spyOn(processTools, 'execProcessToolSync').mockImplementation(unavailable().execSync);
      let placed: ReturnType<typeof placeCaller>;
      try {
        placed = placeCaller(
          sources(() => readAncestors(process.pid, readWithPs, (cause) => causes.push(cause))),
          'home-session',
        );
      } finally {
        spy.mockRestore();
      }
      expect(placed).toEqual({ kind: 'unplaced', reason: "its parent processes can't be read to the top" });
      expect(causes).toEqual(['snapshot unread (reader failed)', 'snapshot unread (reader failed)']);
      expect(shimRuns()).toEqual([]);
    });
  });

  test('doctor comm reads the trusted ps and fails closed without one', () => {
    mountedAttack('doctor', ({ shimRuns }) => {
      const tool = trustedTool('doctor', 'ps', "printf 'fixture-comm-doctor\\n'");
      let spy = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(over(tool).spawnSync);
      try {
        expect(processComm(4242)).toBe('fixture-comm-doctor');
      } finally {
        spy.mockRestore();
      }
      spy = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(unavailable().spawnSync);
      try {
        expect(processComm(4242)).toBe(null);
      } finally {
        spy.mockRestore();
      }
      expect(shimRuns()).toEqual([]);
    });
  });

  test('the running-check reads the trusted pgrep and fails closed without one', () => {
    mountedAttack('running', ({ shimRuns }) => {
      // The shim's pgrep exits 0 — with it, any pattern would read as running. The trusted one
      // reports the pattern gone; without any, the check itself is unreadable.
      const gone = trustedTool('running-gone', 'pgrep', 'exit 1');
      let spy = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(over(gone).spawnSync);
      try {
        expect(realSources.processRunning('fixture-pattern-absent')).toBe(false);
      } finally {
        spy.mockRestore();
      }
      spy = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(unavailable().spawnSync);
      try {
        expect(realSources.processRunning('fixture-pattern-absent')).toBe(null);
      } finally {
        spy.mockRestore();
      }
      expect(shimRuns()).toEqual([]);
    });
  });

  test('the ps readers answer the trusted tool and parse start times as UTC', async () => {
    await mountedAttack('ps-readers', async ({ shimRuns }) => {
      const tool = trustedTool('ps-readers', 'ps', [
        'case "$*" in',
        '  *comm=*) printf \'codex\\n\' ;;',
        '  *command=*) printf \'/fixture/home/codex --remote fixture-session\\n\' ;;',
        '  *lstart=*) printf \'Sat Nov  7 10:00:00 2026\\n\' ;;',
        '  *time=*) printf \'00:00:42\\n\' ;;',
        'esac',
      ].join('\n'));
      const adapter = over(tool);
      const spy = spyOn(processTools, 'execProcessToolSync').mockImplementation(adapter.execSync);
      const spyAsync = spyOn(processTools, 'execProcessTool').mockImplementation(adapter.exec);
      let cpu: number | null | undefined;
      try {
        expect(processCommOf(4242)).toBe('codex');
        expect(processCommandOf(4242)).toBe('/fixture/home/codex --remote fixture-session');
        // The start-time columns are read as UTC: the same text, a zone-anchored instant.
        expect(processStartOf(4242)).toBe(Date.parse('Sat Nov  7 10:00:00 2026 UTC'));
        expect(codexCommandOf(4242)).toBe('/fixture/home/codex --remote fixture-session');
        cpu = await processCpuTimeAsync(4242);
      } finally {
        spyAsync.mockRestore();
        spy.mockRestore();
      }
      expect(cpu).toBe(42_000);

      // The cpu probe rides the adapter's async variant: without a trusted ps it answers no
      // reading, never a zero.
      const closed = spyOn(processTools, 'execProcessTool').mockImplementation(unavailable().exec);
      let cpuClosed: number | null | undefined;
      try {
        cpuClosed = await processCpuTimeAsync(4242);
      } finally {
        closed.mockRestore();
      }
      expect(cpuClosed).toBe(null);

      // The comm gate keeps its meaning through the adapter: a comm that is not the managed
      // CLI never reaches the command question.
      const other = trustedTool('ps-readers-other', 'ps', "printf 'fixture-other-cli\\n'");
      const spyOther = spyOn(processTools, 'execProcessToolSync').mockImplementation(over(other).execSync);
      try {
        expect(codexCommandOf(4242)).toBe(null);
      } finally {
        spyOther.mockRestore();
      }
      expect(shimRuns()).toEqual([]);
    });
  });

  test('the lsof readers answer the trusted tool and fail closed without one', () => {
    mountedAttack('lsof-readers', ({ shimRuns }) => {
      const single = trustedTool('lsof-single', 'lsof', "printf 'p4242\\nn/fixture/working-folder\\n'");
      const many = trustedTool('lsof-many', 'lsof', "printf 'p4242\\nfcwd\\nn/fixture/folder-a\\np4243\\nfcwd\\nn/fixture/folder-b\\n'");
      let spyExec = spyOn(processTools, 'execProcessToolSync').mockImplementation(over(single).execSync);
      try {
        expect(processWorkingFolderOf(4242)).toBe('/fixture/working-folder');
      } finally {
        spyExec.mockRestore();
      }
      let spySpawn = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(over(many).spawnSync);
      let folders: Map<number, string | null> | null = null;
      try {
        folders = processFoldersOf([4242, 4243]);
      } finally {
        spySpawn.mockRestore();
      }
      expect(folders?.get(4242)).toBe('/fixture/folder-a');
      expect(folders?.get(4243)).toBe('/fixture/folder-b');

      spyExec = spyOn(processTools, 'execProcessToolSync').mockImplementation(unavailable().execSync);
      try {
        expect(processWorkingFolderOf(4242)).toBe(null);
      } finally {
        spyExec.mockRestore();
      }
      spySpawn = spyOn(processTools, 'spawnProcessToolSync').mockImplementation(unavailable().spawnSync);
      try {
        expect(processFoldersOf([4242])).toBe(null);
      } finally {
        spySpawn.mockRestore();
      }
      expect(shimRuns()).toEqual([]);
    });
  });
});

describe('the production singleton and the table parser', () => {
  test('the singleton answers from the real table and ignores a live shim', () => {
    mountedAttack('singleton', ({ shimRuns }) => {
      const read = readWithPs(process.pid);
      // Only the real table knows this process's true parent; the shim's crafted chain names a
      // different one.
      expect(read).not.toBeNull();
      expect(read?.ppid).toBe(process.ppid);
      expect(read?.name).toMatch(/^[A-Za-z0-9._+-]+$/);
      expect(shimRuns()).toEqual([]);
    });
  });

  test('table rows parse their start column in the zone the query names', () => {
    const rows = '  4242  fixture-row-cli  Sat Nov  7 10:00:00 2026\nnot a table row\n';
    expect(parseProcessTable(rows, 'UTC')).toEqual([
      { pid: 4242, comm: 'fixture-row-cli', startedAtMs: Date.parse('Sat Nov  7 10:00:00 2026 UTC') },
    ]);
    // The local reading stays for captured fixtures: same text, no zone anchor.
    expect(parseProcessTable(rows)).toEqual([
      { pid: 4242, comm: 'fixture-row-cli', startedAtMs: Date.parse('Sat Nov  7 10:00:00 2026') },
    ]);
  });
});
