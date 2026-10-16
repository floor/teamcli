// A stand-in seat for `bun run e2e`: it draws one of the screens the real commands classify,
// logs every byte it receives, and leaves when its exit line is sent and entered. It runs no
// model and reaches no network, so the real commands can be exercised against a pane that looks
// and answers like a Claude Code seat. Launched as `exec -a claude …`, herdr sees the argv0 its
// profile matches.
//
//   bun scripts/fake-seat.ts <idle|unsent|permission> <log-file>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export type FakeMode = 'idle' | 'unsent' | 'permission';

const FIXTURES: Record<FakeMode, string> = {
  idle: readFileSync(new URL('../test/fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8'),
  unsent: readFileSync(new URL('../test/fixtures/claude-code/2.1.289/unsent-typed-ansi.txt', import.meta.url), 'utf8'),
  permission: readFileSync(new URL('../test/fixtures/claude-code/2.1.289/permission-create-plain.txt', import.meta.url), 'utf8'),
};

/** The screen this mode draws, from the captured Claude Code 2.1.289 fixtures (`src/watch/screen.ts`). */
export function screenFor(mode: FakeMode): string {
  return FIXTURES[mode];
}

/** The typed line a seat leaves on. The exit is the text and the Enter, never the text alone. */
export function isExit(bytes: string): boolean {
  return bytes.includes('/exit\r') || bytes.includes('/exit\n');
}

function main(): void {
  const [mode = 'idle', log = 'fake-seat.log'] = process.argv.slice(2);
  writeFileSync(log, '');
  process.stdout.write(`\x1b[2J\x1b[H${screenFor(mode as FakeMode)}`);
  // Raw: the pane never echoes what is typed at it, and every chunk arrives here whole.
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let seen = '';
  process.stdin.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    appendFileSync(log, `${JSON.stringify(text)}\n`);
    seen += text;
    if (isExit(seen)) process.exit(0);
  });
  // Nothing to do until it is sent: the exit line is the only way out.
  setInterval(() => {}, 1 << 30);
}

if (import.meta.main) main();
