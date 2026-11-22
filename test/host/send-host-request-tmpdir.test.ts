// The warm send host serves a caller whose TMPDIR differs from its own (rfc-bus-send-server §2.4):
// the send path reads the temp folder when it runs, and the host puts the request's environment
// in place for the line. A child loads the modules with one TMPDIR and runs a request naming
// another: every temp path the line uses, and every temp folder it makes, is under the request's;
// after the request the host's own answers again; and no export of the send path's modules holds
// a string with the load-time TMPDIR in it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHILD = resolve(import.meta.dir, '..', 'helpers', 'send-host-tmpdir-child.ts');
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-tmpdir-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Report = {
  loadTmp: string;
  requestTmp: string;
  answer: { v: number; kind: string; code?: number; why?: string; stdout?: string; stderr?: string };
  seen: { socketsDir: string; daemonSocketsDir: string; tmpdir: string; made: string } | null;
  after: { socketsDir: string; tmpdir: string };
  held: string[];
};

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir.replace(/\/$/, '')}/`);

describe('a request with another TMPDIR', () => {
  test("is served, and its temp paths are the request's, not the host's", () => {
    const loadTmp = join(home, 'host-tmp');
    mkdirSync(loadTmp, { recursive: true });
    const child = Bun.spawnSync([process.execPath, CHILD], { env: { ...process.env, HOME: home, TMPDIR: loadTmp }, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw new Error(`the child failed: ${child.stderr.toString()}`);
    const report = JSON.parse(child.stdout.toString().trim().split('\n').pop() ?? '') as Report;
    expect(under(report.loadTmp, loadTmp)).toBe(true);
    expect(report.answer.kind).toBe('ran');
    expect(report.answer.code).toBe(0);
    expect(report.seen).not.toBeNull();
    expect(under(report.seen!.tmpdir, report.requestTmp)).toBe(true);
    expect(report.seen!.socketsDir).toBe(join(report.seen!.tmpdir, 'cc-socks'));
    expect(report.seen!.daemonSocketsDir).toBe(join(report.seen!.tmpdir, 'cc-socks'));
    expect(under(report.seen!.made, report.requestTmp)).toBe(true);
    // The host's own folder again once the request is over.
    expect(under(report.after.tmpdir, loadTmp)).toBe(true);
    expect(report.after.socketsDir).toBe(join(report.after.tmpdir, 'cc-socks'));
    // Nothing the modules exported kept the load-time temp folder.
    expect(report.held).toEqual([]);
  }, 60_000);
});
