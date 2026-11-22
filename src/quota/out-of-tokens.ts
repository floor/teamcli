// The out-of-tokens mark beside the team. Send and the watch read it; they do
// not detect screens themselves. Absent file, absent seat, or a mark that is not that shape is
// none. Tests inject the observation and do not need this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'out-of-tokens.json';

export function tokenMark(dir: string, seat: string): { reason: 'out of tokens' } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const mark = (parsed as Record<string, unknown>)[seat];
    if (mark === null || typeof mark !== 'object' || Array.isArray(mark)) return undefined;
    const held = (mark as { held?: unknown }).held;
    if (held !== 'task' && held !== 'review') return undefined;
    return { reason: 'out of tokens' };
  } catch {
    return undefined;
  }
}
