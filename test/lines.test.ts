import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStopped, copySeat, hasSeat, markStopped, restoreSeat, rewriteCount, seatBlocks, seatIsStopped, takeOut } from '../src/file/lines.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writeTeamFile } from '../src/file/write.ts';

const counted = `format: 1
seats:
  - role: implementer
    name: deepseek
    label: deepseek
    count: 2
    stopped: true
    # kept with the entry
    cli: claude-code
  - role: coordinator
    name: lead
    cli: claude-code
`;

describe('the line-level writer', () => {
  test('a count entry becomes explicit seats, and the comment stays', () => {
    const text = rewriteCount(counted, 'deepseek');
    expect(text).not.toBeNull();
    expect(text).toContain('# kept with the entry');
    expect(text).not.toContain('count:');
    expect(text).toContain('name: deepseek\n');
    expect(text).toContain('name: deepseek-2');
    expect(text).toContain('label: deepseek-2');
    expect(text).toContain('name: lead');
    expect(text?.match(/cli: claude-code/g)).toHaveLength(3);
  });

  test('a counted seat with no label writes the model title on the later instances', () => {
    const split = rewriteCount(`format: 1
seats:
  - role: implementer
    name: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    count: 2
    cli: claude-code
`, 'deepseek');
    expect(split).toContain('name: deepseek\n    model:');
    expect(split).toContain('name: deepseek-2\n    label: deepseek flash v4.1-2\n');
  });

  test('clearing one stopped instance leaves the other stopped', () => {
    const text = clearStopped(counted, 'deepseek-2');
    expect(seatIsStopped(text, 'deepseek')).toBe(true);
    expect(seatIsStopped(text, 'deepseek-2')).toBe(false);
    expect(text).toContain('# kept with the entry');
    expect(text).toContain('name: lead');
  });

  test('a missing seat is put back from the approved copy, beside the neighbour that remains', () => {
    const current = counted.replace(/ {2}- role: implementer[\s\S]*?cli: claude-code\n/, '');
    expect(current).not.toContain('deepseek');
    const restored = restoreSeat(current, counted, 'deepseek-2');
    expect(restored).toContain('name: deepseek-2');
    expect(restored).not.toContain('count:');
    expect(restored).not.toContain('name: deepseek\n');
    expect(restored.indexOf('name: deepseek-2')).toBeLessThan(restored.indexOf('name: lead'));
    expect(restored).toContain('# kept with the entry');
  });

  test('taking one seat out leaves the next seat and a comment that sits above it', () => {
    const text = takeOut(counted, 'deepseek');
    expect(text).not.toContain('name: deepseek\n');
    expect(text).toContain('name: deepseek-2');
    expect(text).not.toContain('count:');
    expect(text).toContain('name: lead');
    const one = takeOut(rewriteCount(counted, 'deepseek') ?? '', 'deepseek-2');
    expect(one).toContain('name: deepseek\n');
    expect(one).not.toContain('name: deepseek-2');
    expect(one).toContain('# kept with the entry');
    expect(one).toContain('name: lead');
  });

  test('stopping one instance of a count leaves the other running', () => {
    const text = markStopped(counted.replace('    stopped: true\n', ''), 'deepseek-2');
    expect(text).not.toContain('count:');
    expect(seatIsStopped(text, 'deepseek')).toBe(false);
    expect(seatIsStopped(text, 'deepseek-2')).toBe(true);
    expect(text).toContain('name: lead');
  });

  test('a name-first seat is found', () => {
    const text = `format: 1
seats:
  - name: helper
    role: implementer
    cli: claude-code
    stopped: true
  - role: coordinator
    name: lead
    cli: claude-code
`;
    expect(hasSeat(text, 'helper')).toBe(true);
    const cleared = clearStopped(text, 'helper');
    expect(seatIsStopped(cleared, 'helper')).toBe(false);
    expect(hasSeat(cleared, 'lead')).toBe(true);
    const gone = without(text, 'helper');
    expect(hasSeat(gone, 'helper')).toBe(false);
    const restored = restoreSeat(gone, text, 'helper');
    expect(hasSeat(restored, 'helper')).toBe(true);
    expect(restored).toContain('- name: helper');
    expect(takeOut(text, 'helper')).not.toContain('helper');
    const stopped = markStopped(text.replace('    stopped: true\n', ''), 'helper');
    expect(hasSeat(stopped, 'helper')).toBe(true);
    expect(seatIsStopped(stopped, 'helper')).toBe(true);
    expect(stopped).toContain('\n    stopped: true\n');
  });

  test('a copied seat takes the source under a new name and title, and taking it out restores the file', () => {
    const text = `format: 1
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    stopped: true
    # the seat stays in this order
`;
    const edited = copySeat(text, 'worker', 'helper');
    expect(hasSeat(edited, 'helper')).toBe(true);
    expect(edited).toContain('    name: helper\n    label: helper\n');
    // The copy starts now; the source keeps its stopped line.
    expect(seatIsStopped(edited, 'helper')).toBe(false);
    expect(seatIsStopped(edited, 'worker')).toBe(true);
    // The copy sits under the source, before the comment that trails it.
    expect(edited.indexOf('name: helper')).toBeLessThan(edited.indexOf('# the seat stays in this order'));
    // The copy is the only change: taking it back out gives the file byte for byte.
    expect(takeOut(edited, 'helper')).toBe(text);
  });

  test('a copy of a counted seat is one seat: the count is split, and the copy has no count', () => {
    const edited = copySeat(counted, 'deepseek', 'helper');
    expect(edited).not.toContain('count:');
    // The split keeps the source's other instance, and the copy is one entry of its own.
    expect(hasSeat(edited, 'deepseek-2')).toBe(true);
    expect(edited.match(/name: helper/g)).toHaveLength(1);
    expect(edited).toContain('label: helper');
    // A comment beside the source stays beside the source: the split writes it on both source
    // instances, and the copy carries fields only.
    expect(edited.match(/# kept with the entry/g)).toHaveLength(2);
    expect(seatIsStopped(edited, 'helper')).toBe(false);
  });

  test('a source with no label is copied with the new name as its title', () => {
    const text = `seats:
  - name: helper
    cli: claude-code
`;
    const edited = copySeat(text, 'helper', 'helper-2');
    expect(edited).toContain('  - name: helper-2\n    label: helper-2\n    cli: claude-code\n');
  });

  test('restoring one removed instance of a count entry inserts that instance only', () => {
    const approved = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: ds
    label: ds
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    count: 3
`;
    const split = rewriteCount(approved, 'ds');
    expect(split).not.toBeNull();
    const removed = takeOut(split ?? '', 'ds-2');
    const restored = restoreSeat(removed, approved, 'ds-2');
    const names = seatBlocks(restored).map((block) => block.name);
    expect(names).toEqual(['lead', 'ds', 'ds-2', 'ds-3']);
    expect(restored).not.toContain('count:');
    expect(validateTeamFile(restored).ok).toBe(true);
  });
});

function without(text: string, name: string): string {
  const block = seatBlocks(text).find((item) => item.name === name);
  if (!block) throw new Error(name);
  const lines = text.split('\n');
  lines.splice(block.start, block.end - block.start);
  return lines.join('\n');
}

describe('the team file write', () => {
  test('an edit that would not validate is refused and the file is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-write-'));
    const path = join(dir, 'team.yaml');
    const original = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
    writeFileSync(path, original);
    const wrote = writeTeamFile(path, original.replace('format: 1', 'format: 9'));
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) expect(wrote.errors[0]?.message).toContain('format');
    expect(readFileSync(path, 'utf8')).toBe(original);
    rmSync(dir, { recursive: true, force: true });
  });
});
