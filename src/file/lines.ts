// Edits the team file by the line. Comments, order and every other seat stay as written.
// Nothing here re-serialises the file.
import { defaultLabel } from './validate.ts';

export type SeatBlock = {
  start: number;
  end: number;
  name: string | null;
  count: number;
};

function indent(line: string): number {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function field(lines: string[], name: string): string | null {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${name}:\\s*(.*)$`).exec(line);
    if (!match) continue;
    return scalar(match[1] ?? '');
  }
  return null;
}

/** A seat's name, including one written on the entry's first line: `- name: helper`. */
function seatName(body: string[]): string | null {
  const inline = /^\s*-\s+name:\s*(.*)$/.exec(body[0] ?? '');
  if (inline) return scalar(inline[1] ?? '');
  return field(body, 'name');
}

/** The seat entries under `seats:`, in order. A file with no seats section has none. */
export function seatBlocks(text: string): SeatBlock[] {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^seats:\s*(#.*)?$/.test(line));
  if (header < 0) return [];
  const key = indent(lines[header] ?? '');
  const blocks: SeatBlock[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const body = lines.slice(start, end);
    const count = Number(field(body, 'count') ?? '1');
    blocks.push({ start, end, name: seatName(body), count: Number.isInteger(count) && count > 0 ? count : 1 });
    start = -1;
  };
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (indent(line) <= key) {
      flush(i);
      break;
    }
    if (/^\s*-\s+/.test(line)) {
      flush(i);
      start = i;
    }
  }
  if (start >= 0) flush(lines.length);
  return blocks;
}

function expanded(block: SeatBlock): string[] {
  if (!block.name) return [];
  const names = [block.name];
  for (let instance = 2; instance <= block.count; instance++) names.push(`${block.name}-${instance}`);
  return names;
}

/** Whether `name` is a seat entry, including one that `count` expands to. */
export function hasSeat(text: string, name: string): boolean {
  return seatBlocks(text).some((block) => expanded(block).includes(name));
}

function replaceLines(text: string, start: number, end: number, insert: string[]): string {
  const lines = text.split('\n');
  lines.splice(start, end - start, ...insert);
  return lines.join('\n');
}

function body(text: string, block: SeatBlock): string[] {
  return text.split('\n').slice(block.start, block.end);
}

function setValue(line: string, value: string): string {
  const match = /^(\s*(?:-\s+)?[A-Za-z0-9_-]+:\s*)(.*)$/.exec(line);
  if (!match) return line;
  const rest = match[2] ?? '';
  const comment = /\s+#.*$/.exec(rest)?.[0] ?? '';
  const raw = rest.slice(0, rest.length - comment.length).trim();
  const quoted = raw.startsWith('"') ? `"${value}"` : raw.startsWith("'") ? `'${value}'` : value;
  return `${match[1]}${quoted}${comment}`;
}

/** One `count` entry becomes one explicit seat per instance. Other lines are copied, not rebuilt. */
export function rewriteCount(text: string, declared: string): string | null {
  const block = seatBlocks(text).find((item) => item.name === declared && item.count > 1);
  if (!block) return null;
  const lines = body(text, block);
  const label = field(lines, 'label');
  const model = field(lines, 'model');
  const version = field(lines, 'version');
  // A counted seat with no label is titled with the model. Later instances need that title
  // written out, or they collide with the first on the same default.
  const implied = label === null && model !== null && version !== null ? defaultLabel(model, version) : null;
  const copies: string[] = [];
  for (let instance = 1; instance <= block.count; instance++) {
    const suffix = instance === 1 ? '' : `-${instance}`;
    copies.push(...lines.flatMap((line) => {
      if (/^\s*count:/.test(line)) return [];
      if (instance === 1) return [line];
      if (/^\s*(?:-\s+)?name:/.test(line)) {
        const renamed = [setValue(line, `${declared}${suffix}`)];
        if (implied === null) return renamed;
        const pad = /^(\s*)/.exec(line)?.[1] ?? '';
        return [...renamed, `${pad}label: ${implied}${suffix}`];
      }
      if (label !== null && /^\s*label:/.test(line)) return [setValue(line, `${label}${suffix}`)];
      return [line];
    }));
  }
  return replaceLines(text, block.start, block.end, copies);
}

/** True when this seat's own entry, or the count entry it comes from, says stopped. */
export function seatIsStopped(text: string, name: string): boolean {
  const lines = text.split('\n');
  const exact = seatBlocks(text).find((block) => block.name === name);
  const block = exact ?? seatBlocks(text).find((item) => expanded(item).includes(name));
  if (!block) return false;
  return lines.slice(block.start, block.end).some((line) => /^\s*stopped:\s*(true|yes)\b/.test(line));
}

/** Drops `stopped: true` from the entry whose name is `name`. A counted entry is split first. */
export function clearStopped(text: string, name: string): string {
  const counted = seatBlocks(text).find((block) => block.count > 1 && expanded(block).includes(name));
  const rewritten = counted?.name ? rewriteCount(text, counted.name) ?? text : text;
  const block = seatBlocks(rewritten).find((item) => item.name === name);
  if (!block) return rewritten;
  const lines = body(rewritten, block).filter((line) => !/^\s*stopped:\s*(true|yes)\s*(#.*)?$/.test(line));
  return replaceLines(rewritten, block.start, block.end, lines);
}

function prepared(text: string, name: string): { text: string; block: SeatBlock } | null {
  const counted = seatBlocks(text).find((block) => block.count > 1 && expanded(block).includes(name));
  const rewritten = counted?.name ? rewriteCount(text, counted.name) ?? text : text;
  const block = seatBlocks(rewritten).find((item) => item.name === name);
  return block ? { text: rewritten, block } : null;
}

/** Drops trailing comments and blank lines back into the file, ahead of the next entry. */
function fieldEnd(lines: string[]): number {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1] ?? '';
    if (line.trim() !== '' && !/^\s*#/.test(line)) break;
    end--;
  }
  return end;
}

/** Takes `name` out of the file. A counted entry is split first, so the other instances stay. */
export function takeOut(text: string, name: string): string {
  const ready = prepared(text, name);
  if (!ready) return text;
  const lines = body(ready.text, ready.block);
  return replaceLines(ready.text, ready.block.start, ready.block.start + fieldEnd(lines), []);
}

/**
 * Copies `fromName`'s entry as a new entry named `toName`. A counted source is split first. The
 * copy carries the entry's fields and no comments or blank lines — a note written beside the
 * source stays with it — drops `count:` and `stopped: true` (it is one seat that starts now),
 * and is named and titled `toName`; a source with no `label:` gains one. It sits directly under
 * the source's last field, so the source's trailing blank lines and comments stay where they
 * were and `takeOut(text, toName)` gives back `text`.
 */
export function copySeat(text: string, fromName: string, toName: string): string {
  const ready = prepared(text, fromName);
  if (!ready) return text;
  const lines = body(ready.text, ready.block);
  const end = fieldEnd(lines);
  const copied = lines.slice(0, end).flatMap((line) => {
    if (line.trim() === '' || /^\s*#/.test(line)) return [];
    if (/^\s*count:/.test(line)) return [];
    if (/^\s*(?:-\s+)?name:/.test(line)) return [setValue(line, toName)];
    if (/^\s*label:/.test(line)) return [setValue(line, toName)];
    if (/^\s*stopped:\s*(?:true|yes)\s*(?:#.*)?$/.test(line)) return [];
    return [line];
  });
  if (!copied.some((line) => /^\s*label:/.test(line))) {
    const nested = copied.find((line) => /^\s+[A-Za-z0-9_-]+:/.test(line));
    const pad = ' '.repeat(nested ? indent(nested) : indent(copied[0] ?? '') + 2);
    const at = copied.findIndex((line) => /^\s*(?:-\s+)?name:/.test(line));
    copied.splice(at + 1, 0, `${pad}label: ${toName}`);
  }
  const insertAt = ready.block.start + end;
  return replaceLines(ready.text, insertAt, insertAt, copied);
}

/** The model fields a swap recipe moves a seat between, by their file keys. */
export type SeatModelFields = {
  cli: string;
  vendor: string;
  model: string;
  version: string;
  display: string;
  launch: string;
  modelFrom?: 'launcher';
  effort?: string;
  account?: string;
};

/** The parser's own key order, so an inserted field lands where the file would have written it. */
const MODEL_FIELDS = ['cli', 'vendor', 'account', 'model_from', 'model', 'version', 'display', 'launch', 'effort'] as const;

/**
 * Rewrites the model fields of `name`'s entry in place: the five every recipe names, and the
 * optional ones — a recipe without `account`, `model_from` or `effort` removes that line, so an
 * account never outlives the vendor it paid. A field the entry does not write is inserted after
 * the last model field it does, in the parser's order. A counted entry is split first.
 */
export function rewriteSeatModel(text: string, name: string, fields: SeatModelFields): string {
  const ready = prepared(text, name);
  if (!ready) return text;
  const lines = body(ready.text, ready.block);
  const values = new Map<string, string | undefined>([
    ['cli', fields.cli],
    ['vendor', fields.vendor],
    ['account', fields.account],
    ['model_from', fields.modelFrom],
    ['model', fields.model],
    ['version', fields.version],
    ['display', fields.display],
    ['launch', fields.launch],
    ['effort', fields.effort],
  ]);
  const nested = lines.find((line) => /^\s+[A-Za-z0-9_-]+:/.test(line));
  const pad = ' '.repeat(nested ? indent(nested) : indent(lines[0] ?? '') + 2);
  for (const key of MODEL_FIELDS) {
    const value = values.get(key);
    const at = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\s+)?${key}:`).test(line));
    if (value === undefined) {
      if (at >= 0) lines.splice(at, 1);
      continue;
    }
    if (at >= 0) {
      lines[at] = setValue(lines[at] ?? '', value);
      continue;
    }
    let insertAt = -1;
    for (const earlier of MODEL_FIELDS.slice(0, MODEL_FIELDS.indexOf(key))) {
      const found = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\s+)?${earlier}:`).test(line));
      if (found > insertAt) insertAt = found;
    }
    if (insertAt < 0) {
      const named = lines.findIndex((line) => /^\s*(?:-\s+)?name:/.test(line));
      insertAt = named >= 0 ? named : 0;
    }
    lines.splice(insertAt + 1, 0, `${pad}${key}: ${value}`);
  }
  return replaceLines(ready.text, ready.block.start, ready.block.end, lines);
}

/** Leaves `name` in the file with `stopped: true`. A counted entry is split first. */
export function markStopped(text: string, name: string): string {
  const ready = prepared(text, name);
  if (!ready) return text;
  const lines = body(ready.text, ready.block);
  if (lines.some((line) => /^\s*stopped:\s*(true|yes)\b/.test(line))) return ready.text;
  const nested = lines.find((line) => /^\s+[A-Za-z0-9_-]+:/.test(line));
  const pad = ' '.repeat(nested ? indent(nested) : indent(lines[0] ?? '') + 2);
  lines.splice(fieldEnd(lines), 0, `${pad}stopped: true`);
  return replaceLines(ready.text, ready.block.start, ready.block.end, lines);
}

/**
 * Puts `name`'s entry back from `approved` when the current text lacks it.
 * The entry is inserted after whichever approved neighbour is still present.
 */
export function restoreSeat(current: string, approved: string, name: string): string {
  if (hasSeat(current, name)) return current;
  const approvedBlocks = seatBlocks(approved);
  const at = approvedBlocks.findIndex((block) => expanded(block).includes(name));
  const source = approvedBlocks[at];
  if (!source || at < 0) return current;
  const inserting = instanceLines(approved, source, name);
  if (!inserting) return current;
  const lines = current.split('\n');
  const header = lines.findIndex((line) => /^seats:\s*(#.*)?$/.test(line));
  if (header < 0) return current;
  const currentBlocks = seatBlocks(current);
  let insertAt = header + 1;
  let placed = false;
  const among = siblingSlot(currentBlocks, source, name);
  if (among !== null) {
    insertAt = among;
    placed = true;
  }
  for (let i = at - 1; i >= 0 && !placed; i--) {
    const neighbour = approvedBlocks[i];
    const found = neighbour ? currentBlocks.find((block) => block.name === neighbour.name) : undefined;
    if (found) {
      insertAt = found.end;
      placed = true;
    }
  }
  for (let i = at + 1; i < approvedBlocks.length && !placed; i++) {
    const neighbour = approvedBlocks[i];
    const found = neighbour ? currentBlocks.find((block) => block.name === neighbour.name) : undefined;
    if (found) {
      insertAt = found.start;
      placed = true;
    }
  }
  if (!placed && currentBlocks.length > 0) {
    const last = currentBlocks[currentBlocks.length - 1];
    if (last) insertAt = last.end;
  }
  lines.splice(insertAt, 0, ...inserting);
  return lines.join('\n');
}

/** Where a restored instance sits among the copies of the same count entry that are still in the file. */
function siblingSlot(currentBlocks: SeatBlock[], source: SeatBlock, name: string): number | null {
  if (source.count <= 1 || !source.name) return null;
  const mine = instanceNumber(source.name, name);
  if (mine === null) return null;
  let lower: SeatBlock | null = null;
  let lowerN = 0;
  let higher: SeatBlock | null = null;
  let higherN = Number.POSITIVE_INFINITY;
  for (const block of currentBlocks) {
    if (!block.name || !expanded(source).includes(block.name)) continue;
    const n = instanceNumber(source.name, block.name);
    if (n === null) continue;
    if (n < mine && n > lowerN) {
      lower = block;
      lowerN = n;
    } else if (n > mine && n < higherN) {
      higher = block;
      higherN = n;
    }
  }
  if (lower) return lower.end;
  return higher ? higher.start : null;
}

function instanceNumber(declared: string, name: string): number | null {
  if (name === declared) return 1;
  const prefix = `${declared}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

// A counted approved entry is one block for every instance. Restoring one of them inserts that
// instance alone; copying the whole `count` entry would repeat the declared name.
function instanceLines(approved: string, source: SeatBlock, name: string): string[] | null {
  if (source.count <= 1 || !source.name) return body(approved, source);
  const rewritten = rewriteCount(approved, source.name);
  if (!rewritten) return null;
  const instance = seatBlocks(rewritten).find((block) => block.name === name);
  return instance ? body(rewritten, instance) : null;
}

/**
 * Rewrites `fromName` to `toName` in the file's `seats:` list, and also updates
 * top-level `coordinator:` / `operator:` or `grant.seat:` when they name `fromName`.
 */
export function renameSeat(text: string, fromName: string, toName: string): string {
  const block = seatBlocks(text).find((item) => item.name === fromName && item.count <= 1);
  if (!block) return text;
  const blockLines = body(text, block).map((line) =>
    /^\s*(?:-\s+)?name:/.test(line) ? setValue(line, toName) : line,
  );
  const withSeat = replaceLines(text, block.start, block.end, blockLines);
  const lines = withSeat.split('\n');
  let inGrant = false;
  let grantIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const ind = indent(line);
    if (inGrant && ind <= grantIndent) inGrant = false;
    if (/^grant:\s*(#.*)?$/.test(line)) {
      inGrant = true;
      grantIndent = ind;
      continue;
    }
    if (ind === 0) {
      const m = /^(coordinator|operator):\s*(.*)$/.exec(line);
      if (m && scalar(m[2] ?? '') === fromName) {
        lines[i] = setValue(line, toName);
      }
    } else if (inGrant) {
      const m = /^\s+seat:\s*(.*)$/.exec(line);
      if (m && scalar(m[1] ?? '') === fromName) {
        lines[i] = setValue(line, toName);
      }
    }
  }
  return lines.join('\n');
}
