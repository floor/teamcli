// The macOS kernel reader behind the caller's ancestor walk: argv[0] parsed from a
// KERN_PROCARGS2 page, the walk preferring the kernel and falling back to the `ps` table whole,
// and, on a Mac under Bun, the kernel's answer equal to `ps -o ppid=,comm=` for this process's
// own chain.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parsePsSnapshot, readAncestors, readWithPs } from '../src/caller.ts';
import * as processTools from '../src/process-tools-adapter.ts';
import { argv0OfProcArgs, kernelProcess, kernelProcessBound, setKernelProcessForTests, type KernelProcess } from '../src/process-kernel.ts';

afterEach(() => {
  setKernelProcessForTests(undefined);
});

function page(argc: number, parts: string[], pad = 3): { bytes: Uint8Array; length: number } {
  const chunks: number[] = [];
  const head = new Uint8Array(4);
  new DataView(head.buffer).setInt32(0, argc, true);
  chunks.push(...head);
  const [exec, ...rest] = parts;
  chunks.push(...Buffer.from(exec ?? ''), ...new Array(pad).fill(0));
  for (const part of rest) chunks.push(...Buffer.from(part), 0);
  const bytes = new Uint8Array(chunks.length + 16);
  bytes.set(chunks);
  return { bytes, length: chunks.length };
}

describe('argv[0] from a KERN_PROCARGS2 page', () => {
  test('the argument after the exec path and its padding', () => {
    const { bytes, length } = page(2, ['/usr/local/bin/node', 'cursor-agent', '--flag']);
    expect(argv0OfProcArgs(bytes, length)).toBe('cursor-agent');
  });

  test('a login shell keeps its dash; the caller strips it as ps does', () => {
    const { bytes, length } = page(1, ['/bin/zsh', '-zsh']);
    expect(argv0OfProcArgs(bytes, length)).toBe('-zsh');
  });

  test('no argument, a short page, or an argv[0] cut at the page end reads as nothing', () => {
    expect(argv0OfProcArgs(page(0, ['/bin/zsh', 'zsh']).bytes, page(0, ['/bin/zsh', 'zsh']).length)).toBeNull();
    expect(argv0OfProcArgs(new Uint8Array(3), 3)).toBeNull();
    const cut = page(1, ['/bin/zsh', 'zsh']);
    expect(argv0OfProcArgs(cut.bytes, cut.length - 1)).toBeNull();
    const onlyExec = page(1, ['/bin/zsh']);
    expect(argv0OfProcArgs(onlyExec.bytes, onlyExec.length)).toBeNull();
  });
});

describe('the walk prefers the kernel and falls back to the ps table whole', () => {
  const chain: Record<number, KernelProcess> = {
    500: { ppid: 400, argv0: '/opt/bin/team' },
    400: { ppid: 300, argv0: '-zsh' },
    300: { ppid: 1, argv0: 'herdr' },
  };

  test('a kernel chain to pid 1 is the walk, and ps is never started', () => {
    setKernelProcessForTests((pid) => chain[pid]);
    const ps = spyOn(processTools, 'execProcessToolSync');
    try {
      expect(readAncestors(500, readWithPs)).toEqual([
        { pid: 500, name: 'team' },
        { pid: 400, name: 'zsh' },
        { pid: 300, name: 'herdr' },
      ]);
      expect(ps).not.toHaveBeenCalled();
    } finally {
      ps.mockRestore();
    }
  });

  test('one unreadable step drops the kernel chain and the ps table answers the whole walk', () => {
    setKernelProcessForTests((pid) => (pid === 400 ? undefined : chain[pid]));
    const ps = spyOn(processTools, 'execProcessToolSync').mockImplementation((() => '500 400 team\n400 300 bash\n300 1 herdr\n') as never);
    try {
      // The names are the table's (bash, not the kernel's zsh): no kernel step is mixed in.
      expect(readAncestors(500, readWithPs)).toEqual([
        { pid: 500, name: 'team' },
        { pid: 400, name: 'bash' },
        { pid: 300, name: 'herdr' },
      ]);
      expect(ps).toHaveBeenCalled();
    } finally {
      ps.mockRestore();
    }
  });

  test('a reader handed in by the caller is never replaced by the kernel', () => {
    setKernelProcessForTests(() => { throw new Error('the kernel reader must not run'); });
    const read = (pid: number) => (pid === 7 ? { ppid: 1, name: 'fixture' } : null);
    expect(readAncestors(7, read)).toEqual([{ pid: 7, name: 'fixture' }]);
  });
});

const live = process.platform === 'darwin' && process.versions.bun !== undefined;

describe.if(live)('on this Mac, the kernel answers as ps does', () => {
  test('the reader binds', () => {
    expect(kernelProcessBound()).toBe(true);
  });

  test("this process's own chain: the same pids and names from the kernel as from ps", () => {
    const table = parsePsSnapshot(execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }));
    let at = process.pid;
    let steps = 0;
    while (at > 1 && steps < 64) {
      const fromKernel = kernelProcess(at);
      const fromPs = table.get(at);
      expect(fromPs).toBeDefined();
      expect(fromKernel).toBeDefined();
      expect(fromKernel?.ppid).toBe(fromPs?.ppid);
      const name = (fromKernel?.argv0 ?? '').split('/').pop()?.replace(/^-/, '');
      expect(name).toBe(fromPs?.name);
      at = fromPs?.ppid ?? 1;
      steps += 1;
    }
    expect(steps).toBeGreaterThan(0);
  });

  test('the walk from this process equals the ps-table walk', () => {
    const kernel = readAncestors(process.pid, readWithPs);
    setKernelProcessForTests(null);
    const table = readAncestors(process.pid, readWithPs);
    expect(kernel).toEqual(table);
  });
});
