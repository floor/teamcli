// `team usage` reads files: no pane, no CLI's own session file, no lab's credential. The caller
// is handed in below, so placing it — the process-table read the command's own page documents —
// is not part of what this run records, and the one command here is the root resolution. The run
// in test/usage-traps-run.ts records every path `readFileSync` opens and every command spawned,
// over a home holding trap files where those CLI files would live, with a herdr whose every
// function would fail the run if it were called. This is the whole claim: the record below names
// no trap, and every path it does name is the project's own state or the tool's own folders.
import { expect, test } from 'bun:test';

type Traps = {
  code: number;
  err: string;
  out: string;
  opened: string[];
  ran: string[];
  root: string;
  home: string;
  traps: string[];
};

test('usage opens no CLI session file, no CLI credential, and runs nothing but the resolver', async () => {
  const proc = Bun.spawn(['bun', 'test/usage-traps-run.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as Traps;
  expect(parsed.err).toBe('');
  expect(parsed.code).toBe(0);
  expect(parsed.out).toContain('"mine": "acme"');

  // The recorder is armed: it saw the two files the command must read.
  expect(parsed.opened).toContain(`${parsed.root}/.agents/team.yaml`);
  expect(parsed.opened).toContain(`${parsed.root}/.agents/team.state.json`);

  // No trap, and nothing anywhere else on the machine: every open is the project's state, the
  // store, or the tool's own signing key folder. The key folder is allowed deliberately, and this
  // is the test that pins what the allowance means: the key read is `approvalStanding` verifying
  // the approved copy with the team's own key, exactly as `status` verifies it — a figure printed
  // against budgets nobody verified would be worse than the one read every command already makes —
  // and it is not a CLI's credential. The design's first draft promised `usage` reads no key at
  // all; the after-review of S1 corrected that promise, and the claim here is the corrected one:
  // no pane, no CLI's session file, no lab's credential.
  for (const trap of parsed.traps) expect(parsed.opened).not.toContain(trap);
  const allowed = [`${parsed.root}/`, `${parsed.home}/.config/team/`, `${parsed.home}/.config/team-key/`];
  for (const path of parsed.opened) {
    expect(allowed.some((prefix) => path.startsWith(prefix)), `${path} is outside the tool's own files`).toBe(true);
  }

  // The one command run is the root resolution; no pane, no CLI, no shell was touched.
  expect(parsed.ran).toEqual(['git rev-parse --path-format=absolute --git-common-dir']);
});
