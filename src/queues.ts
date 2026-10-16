import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TeamFile } from './file/types.ts';

export type QueueDepths = Readonly<Record<string, number | null>>;
const MAX_QUEUE_BYTES = 1024 * 1024;

/** Top-level numbered entries and Markdown tasks, outside fenced examples. */
export function queueDepth(text: string): number {
  let fence: { marker: string; length: number } | null = null;
  const items: { indent: number; done: boolean }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const item = /^( {0,3})(?:\d+[.)]\s+|[-*+]\s+(?=\[[ xX]\]\s))(.+)$/.exec(line);
    if (!item) continue;
    items.push({ indent: item[1]!.length, done: /^\[[xX]\](?:\s|$)/.test(item[2]!) });
  }
  const indent = items.reduce((min, item) => Math.min(min, item.indent), Infinity);
  return items.filter((item) => item.indent === indent && !item.done).length;
}

/** Unknown is kept distinct from an empty queue. No queue content leaves this reader. */
export function readQueueDepths(team: TeamFile, root: string, home: string = homedir(), temporary: readonly string[] = []): QueueDepths | null {
  const configured = team.watch.queueDir;
  if (!configured) return null;
  const path = configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : resolve(root, configured);
  const depths: Record<string, number | null> = Object.create(null);
  for (const name of new Set([...team.seats.map((seat) => seat.name), ...temporary])) {
    depths[name] = null;
    // A declared seat is a basename; keep the read inside the configured directory even for
    // callers constructing a TeamFile directly rather than passing through validation.
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') continue;
    try {
      const file = join(path, `${name}.md`);
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_QUEUE_BYTES) continue;
      const text = readFileSync(file, 'utf8');
      if (Buffer.byteLength(text) <= MAX_QUEUE_BYTES) depths[name] = queueDepth(text);
    } catch { /* Missing or unreadable is unknown. */ }
  }
  return depths;
}
