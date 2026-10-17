import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TeamFile } from './file/types.ts';

export type QueueDepths = Readonly<Record<string, number | null>>;
const MAX_QUEUE_BYTES = 1024 * 1024;
/** The unclaimed marker in the backlog file: `claimed:` or `done:`, any case, at a word's edge. */
const CLAIM_MARKER = /(?:^|[\s—–-])(?:claimed|done)\s*:/i;

type Block = {
  indent: number;
  numbered: boolean;
  done: boolean;
  /** The item's own line and the lines under it, up to the next item at its own or a shallower indent. */
  lines: string[];
};

/** The list items of a Markdown file, outside fenced examples, each with the text that belongs to it. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let fence: { marker: string; length: number } | null = null;
  let open: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const item = /^( {0,3})(?:\d+[.)]\s+|[-*+]\s+(?=\[[ xX]\]\s))(.+)$/.exec(line);
    if (!item) {
      open?.lines.push(line);
      continue;
    }
    const indent = item[1]!.length;
    // A deeper item is a child: it belongs to the open item's text, and is no item of its own.
    if (open && indent > open.indent) {
      open.lines.push(line);
      continue;
    }
    if (open) blocks.push(open);
    open = { indent, numbered: /^\d/.test(line.slice(indent)), done: /^\[[xX]\](?:\s|$)/.test(item[2]!), lines: [line] };
  }
  if (open) blocks.push(open);
  return blocks;
}

/** The shallower indent the file's items share: what counts as top level in it. */
function topIndent(blocks: readonly Block[]): number {
  return blocks.reduce((min, block) => Math.min(min, block.indent), Infinity);
}

/** Top-level numbered entries and Markdown tasks, outside fenced examples. */
export function queueDepth(text: string): number {
  const items = blocksOf(text);
  const indent = topIndent(items);
  return items.filter((item) => item.indent === indent && !item.done).length;
}

/**
 * Top-level numbered entries of a backlog file that no one has claimed yet: one that is not
 * checked and whose own text, or the text under it, carries no `claimed:` or `done:` marker.
 */
export function backlogDepth(text: string): number {
  const items = blocksOf(text).filter((item) => item.numbered);
  const indent = topIndent(items);
  return items.filter((item) => item.indent === indent && !item.done && !item.lines.some((line) => CLAIM_MARKER.test(line))).length;
}

/** The configured queue directory, or null when the file names none. */
function queueDirectory(team: TeamFile, root: string, home: string): string | null {
  const configured = team.watch.queueDir;
  if (!configured) return null;
  return configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : resolve(root, configured);
}

/** One queue file's text, or null when it is missing, not a file, or over the size bound. */
function readBounded(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_QUEUE_BYTES) return null;
    const text = readFileSync(file, 'utf8');
    return Buffer.byteLength(text) <= MAX_QUEUE_BYTES ? text : null;
  } catch { return null; } // Missing or unreadable is unknown.
}

/** Unknown is kept distinct from an empty queue. No queue content leaves this reader. */
export function readQueueDepths(team: TeamFile, root: string, home: string = homedir(), temporary: readonly string[] = []): QueueDepths | null {
  const path = queueDirectory(team, root, home);
  if (!path) return null;
  const depths: Record<string, number | null> = Object.create(null);
  for (const name of new Set([...team.seats.map((seat) => seat.name), ...temporary])) {
    depths[name] = null;
    // A declared seat is a basename; keep the read inside the configured directory even for
    // callers constructing a TeamFile directly rather than passing through validation.
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') continue;
    const text = readBounded(join(path, `${name}.md`));
    if (text !== null) depths[name] = queueDepth(text);
  }
  return depths;
}

/** Unclaimed items in the queue directory's `linear-backlog.md`. Unknown, not zero, when it can't be read. */
export function readBacklogDepth(team: TeamFile, root: string, home: string = homedir()): number | null {
  const path = queueDirectory(team, root, home);
  if (!path) return null;
  const text = readBounded(join(path, 'linear-backlog.md'));
  return text === null ? null : backlogDepth(text);
}
