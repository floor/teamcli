import { expect, test } from 'bun:test';
import { parentOfBsdInfo, parentOfProcStat, readProcessParent } from '../src/process-parent-adapter.ts';

test('the kernel record keeps a sub-second birth with its pid and parent', () => {
  const bytes = new Uint8Array(136);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 99, true);
  view.setUint32(16, 11, true);
  view.setBigUint64(120, 1_700_000_000n, true);
  view.setBigUint64(128, 123_456n, true);
  expect(parentOfBsdInfo(bytes, 99)).toEqual({ pid: 99, ppid: 11, birth: 1_700_000_000_123_456 });
  expect(parentOfBsdInfo(bytes, 100)).toBeNull();
  expect(parentOfBsdInfo(bytes.subarray(1), 99)).toBeNull();
  view.setBigUint64(128, 1_000_000n, true);
  expect(parentOfBsdInfo(bytes, 99)).toBeNull();
});

test('the process stat reader extracts only pid, parent and birth despite parentheses in comm', () => {
  const fields = Array(20).fill('0');
  fields[0] = 'S'; fields[1] = '11'; fields[19] = '123456';
  const text = `99 (fixture ) name) ${fields.join(' ')}`;
  expect(parentOfProcStat(text, 99)).toEqual({ pid: 99, ppid: 11, birth: 123456 });
  expect(parentOfProcStat(text, 100)).toBeNull();
  expect(parentOfProcStat('not a process record', 99)).toBeNull();
});

test('the production adapter reads this test process without args or environments', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    expect(readProcessParent(process.pid)).toBeNull();
    return;
  }
  const first = readProcessParent(process.pid);
  expect(first).not.toBeNull();
  expect(first?.pid).toBe(process.pid);
  expect(first?.ppid).toBe(process.ppid);
  expect(readProcessParent(process.pid)).toEqual(first);
  if (process.platform === 'darwin') {
    expect(first!.birth).toBeGreaterThan((Date.now() - 600_000) * 1000);
    expect(first!.birth).toBeLessThanOrEqual(Date.now() * 1000);
  }
  expect(readProcessParent(-1)).toBeNull();
});
