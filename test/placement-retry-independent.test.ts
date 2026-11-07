// Independent scenes: a placement walk retries one fresh snapshot and never skips a pid.
// Aimed at b7243a9e4. The process reader is fake. A log line names the cause and the pid only.
import { expect, test } from 'bun:test';
import { placeCaller, readAncestors, type Process, type ReadProcess } from '../src/caller.ts';

const MARKER = 'pebble-marker';
const ARG = 'pebble-arg-secret';
const REFUSAL = "its parent processes can't be read to the top";

function placed(chain: Process[] | null): ReturnType<typeof placeCaller> {
  return placeCaller({
    ancestors: () => chain,
    agents: () => [],
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: true,
  });
}

function listen<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const prior = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { value: run(), lines };
  } finally {
    console.error = prior;
  }
}

function quiet(lines: string[]): void {
  for (const line of lines) {
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain(ARG);
  }
}

test('a hole in the first snapshot and a whole second snapshot places, with one log line', () => {
  let reads = 0;
  const read: ReadProcess = () => {
    reads += 1;
    if (reads === 1) return null;
    return { ppid: 1, name: MARKER };
  };
  const { value, lines } = listen(() => readAncestors(5200, read));
  expect(reads).toBe(2);
  expect(value).toEqual([{ pid: 5200, name: MARKER }]);
  expect(placed(value)).toEqual({ kind: 'owner' });
  expect(lines).toEqual(['team caller: missing pid 5200']);
  quiet(lines);
});

test('holes in both snapshots refuse after two reads and never take a third', () => {
  let reads = 0;
  const read: ReadProcess = () => {
    reads += 1;
    if (reads >= 3) return { ppid: 1, name: MARKER };
    return null;
  };
  const { value, lines } = listen(() => readAncestors(5100, read));
  expect(reads).toBe(2);
  expect(value).toBeNull();
  expect(placed(value)).toEqual({ kind: 'unplaced', reason: REFUSAL });
  expect(lines).toEqual(['team caller: missing pid 5100', 'team caller: missing pid 5100']);
  quiet(lines);
});

test('a reader that throws once then answers places, and keeps the first log line', () => {
  let reads = 0;
  const read: ReadProcess = () => {
    reads += 1;
    if (reads === 1) throw new Error('reader broke');
    return { ppid: 1, name: MARKER };
  };
  const { value, lines } = listen(() => readAncestors(5300, read));
  expect(reads).toBe(2);
  expect(value).toEqual([{ pid: 5300, name: MARKER }]);
  expect(placed(value)).toEqual({ kind: 'owner' });
  expect(lines).toEqual(['team caller: snapshot unread (reader failed)']);
  quiet(lines);
});

test('a timeout on both snapshots refuses with two timeout lines', () => {
  let reads = 0;
  const read: ReadProcess = () => {
    reads += 1;
    const error = new Error('bounded read') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const { value, lines } = listen(() => readAncestors(5400, read));
  expect(reads).toBe(2);
  expect(value).toBeNull();
  expect(placed(value)).toEqual({ kind: 'unplaced', reason: REFUSAL });
  expect(lines).toEqual(['team caller: snapshot unread (timeout)', 'team caller: snapshot unread (timeout)']);
  quiet(lines);
});

test('a missing middle pid is not skipped when the child names a pid above it', () => {
  const asked: number[] = [];
  let reads = 0;
  const read: ReadProcess = (pid) => {
    reads += 1;
    asked.push(pid);
    if (reads > 6) return { ppid: 1, name: MARKER };
    if (pid === 6100) return { ppid: 6200, name: MARKER };
    if (pid === 6200) return { ppid: 6300, name: ARG };
    return null;
  };
  const { value, lines } = listen(() => readAncestors(6100, read));
  expect(value).toBeNull();
  expect(placed(value)).toEqual({ kind: 'unplaced', reason: REFUSAL });
  expect(asked).toEqual([6100, 6200, 6300, 6100, 6200, 6300]);
  expect(reads).toBe(6);
  expect(lines).toEqual(['team caller: missing pid 6300', 'team caller: missing pid 6300']);
  quiet(lines);
});
