// Parity between the in-process CLI and the warm send host's runner (rfc-bus-send-server §5): the
// same line, the same placement, the same files give the same output and exit code, in both
// orders (the host warm from the other path's run first, and cold). The scene lives in a temporary
// HOME, given to a child process so the modules load with it, as the host's would.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHILD = resolve(import.meta.dir, '..', 'helpers', 'send-host-parity-child.ts');
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-parity-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Outcome = { kind: string; code?: number; stdout?: string; stderr?: string; why?: string; v?: number };
type Report = { results: { argv: string[]; direct: Outcome; hosted: Outcome }[]; otherHome: Outcome; otherTmp: Outcome; after: { direct: Outcome; hosted: Outcome } };

function run(order: string): Report {
  const child = Bun.spawnSync([process.execPath, CHILD, order], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const text = child.stdout.toString().trim().split('\n').pop() ?? '';
  if (child.exitCode !== 0) throw new Error(`the parity child failed: ${child.stderr.toString()}`);
  return JSON.parse(text) as Report;
}

const strip = (one: Outcome): Outcome => {
  const { v: _v, ...rest } = one;
  // A send id is minted per run; the two runs mint two.
  return { ...rest, stdout: rest.stdout?.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'), stderr: rest.stderr?.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>') };
};

describe('the host runs a line exactly as the CLI does', () => {
  for (const order of ['direct-first', 'hosted-first']) {
    test(`admitted, refused and failing lines match (${order})`, () => {
      const report = run(order);
      expect(report.results.length).toBe(7);
      for (const one of report.results) {
        expect(one.hosted.kind).toBe('ran');
        expect(strip(one.hosted)).toEqual(strip(one.direct));
      }
      const [admitted, , unknown, own] = report.results;
      expect(admitted!.direct.code).toBe(0);
      expect(unknown!.direct.code).toBe(1);
      expect(own!.direct.stderr).toContain('that is your own seat');
    }, 120_000);
  }

  test('another HOME or TMPDIR is handed back, and the next matching line still matches', () => {
    const report = run('direct-first');
    expect(report.otherHome).toEqual({ v: 1, kind: 'fallback', why: "HOME differs from the send host's" });
    expect(report.otherTmp).toEqual({ v: 1, kind: 'fallback', why: "TMPDIR differs from the send host's" });
    expect(strip(report.after.hosted)).toEqual(strip(report.after.direct));
  }, 120_000);
});
