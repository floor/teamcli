// A launch typed into a pane whose shell has not reached its prompt is refused by the terminal
// host while the terminal is in canonical mode (1024 bytes a line). paneRun waits for the prompt
// and offers the same line again; any other refusal is still a refusal at once.
import { afterEach, describe, expect, test } from 'bun:test';
import { paneRun, setCaptureExec } from '../src/herdr.ts';

const CANONICAL = '{"error":{"code":"pane_send_failed","message":"input contains a 1105-byte line but the terminal is in canonical mode with a 1024-byte limit; wait for the shell prompt and retry"},"id":"cli:request"}';

function refusal(stderr: string): Error {
  return Object.assign(new Error('herdr exited 1'), { status: 1, stderr, stdout: '' });
}

afterEach(() => setCaptureExec(null));

describe('paneRun and a shell that is still starting', () => {
  test('the line is offered again until the shell takes it', () => {
    const lines: string[] = [];
    let calls = 0;
    setCaptureExec((args) => {
      calls += 1;
      lines.push(args[args.length - 1]!);
      if (calls <= 2) throw refusal(CANONICAL);
      return '{"id":"cli:request","result":{"type":"ok"}}';
    });
    expect(paneRun('w1:p1', 'claude --name worker', 'crew')).toBe(true);
    expect(calls).toBe(3);
    expect(new Set(lines)).toEqual(new Set(['claude --name worker']));
  });

  test('any other refusal is not retried', () => {
    let calls = 0;
    setCaptureExec(() => {
      calls += 1;
      throw refusal('{"error":{"code":"pane_not_found","message":"no such pane"}}');
    });
    expect(paneRun('w1:p1', 'claude', 'crew')).toBe(false);
    expect(calls).toBe(1);
  });
});
