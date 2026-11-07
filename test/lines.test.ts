import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStopped, copySeat, hasSeat, markStopped, restoreSeat, rewriteCount, rewriteSeatModel, seatBlocks, seatIsStopped, takeOut } from '../src/file/lines.ts';
import { setSeatStopped } from '../src/file/stopped-mark.ts';
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
  test('a list inside a seat is part of that seat, so the whole seat is taken out and marked', () => {
    // A seat whose first key is not `name:` and that carries a list (`delivery_order:` / `- typed`)
    // was cut after the list's key: its other fields fell to the seat above, and the file no
    // longer parsed (seen live on a registry team: line 149: unexpected indentation).
    const text = [
      'session: acme',
      'seats:',
      '  - role: implementer',
      '    name: alpha',
      '    delivery_order:',
      '      - typed',
      '    cli: claude-code',
      '  - role: reviewer',
      '    name: beta',
      '    delivery_order:',
      '      - typed',
      '      - drop',
      '    cli: codex',
      '    launch: codex -m gpt',
      '  - role: reviewer',
      '    name: gamma',
      '    cli: claude-code',
      '',
    ].join('\n');
    expect(seatBlocks(text).map((block) => [block.name, block.start, block.end])).toEqual([
      ['alpha', 2, 7], ['beta', 7, 14], ['gamma', 14, 18],
    ]);
    expect(takeOut(text, 'beta')).toBe([
      'session: acme',
      'seats:',
      '  - role: implementer',
      '    name: alpha',
      '    delivery_order:',
      '      - typed',
      '    cli: claude-code',
      '  - role: reviewer',
      '    name: gamma',
      '    cli: claude-code',
      '',
    ].join('\n'));
    expect(seatIsStopped(markStopped(text, 'beta'), 'beta')).toBe(true);
    expect(seatIsStopped(markStopped(text, 'beta'), 'alpha')).toBe(false);
  });

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
    expect(split).toContain('name: deepseek-2\n    label: "deepseek flash v4.1-2"\n');
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

  test('copying a nicknamed seat drops nickname so the edited file validates without a duplicate nickname', () => {
    const text = [
      'format: 1',
      'project: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    label: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
      '  - role: implementer',
      '    name: builder-5',
      '    label: "Orion · builder"',
      '    nickname: Orion',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
      '',
    ].join('\n');
    const copied = copySeat(text, 'builder-5', 'builder-6');
    const validated = validateTeamFile(copied);
    expect(validated.ok ? '' : validated.errors.map((e) => e.message).join('; ')).toBe('');
    expect(copied.match(/nickname: Orion/g)).toHaveLength(1);
    expect(takeOut(copied, 'builder-6')).toBe(text);
  });

  test('a seat written on a bare "-" line is found, and a copy drops nickname and any comment on the dash', () => {
    const text = [
      'format: 1',
      'project: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    label: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
      '  - # edited by config set',
      '    role: implementer',
      '    name: builder-5',
      '    label: "Orion · builder"',
      '    nickname: Orion',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
      '  -',
      '    role: reviewer',
      '    name: reviewer-1',
      '    label: reviewer-1',
      '    cli: codex',
      '    vendor: openai',
      '    model: GPT',
      '    version: "6.4"',
      '    launch: codex',
      '',
    ].join('\n');
    expect(seatBlocks(text).map((block) => block.name)).toEqual(['lead', 'builder-5', 'reviewer-1']);
    expect(hasSeat(text, 'builder-5')).toBe(true);
    expect(hasSeat(text, 'reviewer-1')).toBe(true);
    const copied = copySeat(text, 'builder-5', 'builder-6');
    expect(hasSeat(copied, 'builder-6')).toBe(true);
    expect(copied).toContain([
      '  -',
      '    role: implementer',
      '    name: builder-6',
      '    label: "builder-6"',
      '    cli: claude-code',
    ].join('\n'));
    expect(copied.match(/nickname: Orion/g)).toHaveLength(1);
    expect(copied.match(/# edited by config set/g)).toHaveLength(1);
    expect(validateTeamFile(copied).ok).toBe(true);
    expect(takeOut(copied, 'builder-6')).toBe(text);
  });

  test('a seat written as a flow mapping is skipped by the line writer, and the record editor rewrites its mark', () => {
    // The line writer finds no name inside the braces, so its writes skip the seat whole — its
    // line is never rewritten or dropped, and the file still validates. A revival no longer
    // depends on that writer: the parsed record declares the seat, and setSeatStopped addresses
    // it through the record editor, which rewrites the item's own mark.
    const text = [
      'format: 1',
      'project: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    label: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
      '  - { role: implementer, name: flow-seat, label: flow-seat, cli: claude-code, vendor: anthropic, model: Claude Opus, version: "5.5", launch: claude, stopped: true }',
      '',
    ].join('\n');
    expect(validateTeamFile(text).ok).toBe(true);
    expect(seatBlocks(text).map((block) => block.name)).toEqual(['lead', null]);
    expect(hasSeat(text, 'flow-seat')).toBe(false);
    expect(seatIsStopped(text, 'flow-seat')).toBe(false);
    expect(clearStopped(text, 'flow-seat')).toBe(text);
    expect(markStopped(text, 'flow-seat')).toBe(text);
    expect(takeOut(text, 'flow-seat')).toBe(text);
    expect(validateTeamFile(clearStopped(text, 'flow-seat')).ok).toBe(true);

    const cleared = setSeatStopped(text, 'flow-seat', false);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(validateTeamFile(cleared.text).ok).toBe(true);
    expect(cleared.text).not.toContain('stopped: true');
    expect(hasSeat(cleared.text, 'flow-seat')).toBe(true);
    const marked = setSeatStopped(cleared.text, 'flow-seat', true);
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    expect(seatIsStopped(marked.text, 'flow-seat')).toBe(true);
    expect(validateTeamFile(marked.text).ok).toBe(true);
  });

  test('a seat list written at the seats header\'s own column is found and rewritten', () => {
    // YAML's indentless sequence: `- role:` starts an item of the `seats:` list at the header's
    // own column. The validator reads those entries as seats, so the writers must too.
    const text = [
      'format: 1',
      'project: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '- role: coordinator',
      '  name: lead',
      '  label: lead',
      '  cli: claude-code',
      '  vendor: anthropic',
      '  model: Claude Opus',
      '  version: "5.5"',
      '  launch: claude',
      '- role: implementer',
      '  name: parked',
      '  label: parked',
      '  cli: claude-code',
      '  vendor: anthropic',
      '  model: Claude Opus',
      '  version: "5.5"',
      '  launch: claude',
      '  stopped: true',
      '',
    ].join('\n');
    expect(validateTeamFile(text).ok).toBe(true);
    expect(seatBlocks(text).map((block) => block.name)).toEqual(['lead', 'parked']);
    expect(hasSeat(text, 'parked')).toBe(true);
    expect(seatIsStopped(text, 'parked')).toBe(true);
    const cleared = clearStopped(text, 'parked');
    expect(seatIsStopped(cleared, 'parked')).toBe(false);
    expect(validateTeamFile(cleared).ok).toBe(true);
    const marked = setSeatStopped(cleared, 'parked', true);
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    expect(seatIsStopped(marked.text, 'parked')).toBe(true);
    expect(validateTeamFile(marked.text).ok).toBe(true);
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

  test('a rewritten double-quoted launch carries its inner quotes and backslashes escaped', () => {
    const text = `format: 1
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
    display: Claude Opus 5.5
    launch: "claude --model claude-opus-5-5"
`;
    const launch = 'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s kimi-api-key -a "$USER" -w) claude --model kimi-k2.5 --note C:\\tmp';
    const edited = rewriteSeatModel(text, 'lead', {
      cli: 'claude-code', vendor: 'moonshot', model: 'Kimi K2.5', version: '2.5', display: 'Kimi K2.5 2.5', launch,
    });
    const parsed = validateTeamFile(edited);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.errors)).toBe(true);
    if (parsed.ok) expect(parsed.team.seats.find((seat) => seat.name === 'lead')?.launch).toBe(launch);
  });

  test('a rewritten single-quoted launch doubles the single quotes it carries', () => {
    const text = `format: 1
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
    display: Claude Opus 5.5
    launch: 'claude --model claude-opus-5-5'
`;
    const launch = "claude --append-system-prompt 'be brief' --model kimi-k2.5";
    const edited = rewriteSeatModel(text, 'lead', {
      cli: 'claude-code', vendor: 'moonshot', model: 'Kimi K2.5', version: '2.5', display: 'Kimi K2.5 2.5', launch,
    });
    const parsed = validateTeamFile(edited);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.errors)).toBe(true);
    if (parsed.ok) expect(parsed.team.seats.find((seat) => seat.name === 'lead')?.launch).toBe(launch);
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

for (const id of ['123456789012', '123456e78901', '0x1f', '1e5a3f']) {
  test(`a copied unlabelled seat keeps generated label ${id} as text`, () => {
    const source = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8').replace(/^\s*label:.*\n/gm, '');
    expect(validateTeamFile(source).ok).toBe(true);
    const edited = copySeat(source, 'codex-acme', id);
    expect(edited).not.toBe(source); expect(hasSeat(edited, id)).toBe(true);
    const read = validateTeamFile(edited);
    expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
    if (read.ok) expect(read.team.seats.find(seat => seat.name === id)?.label).toBe(id);
  });
}

const insertionSource = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
test('an inserted counted label keeps punctuation in the generated model title as text', () => {
  const source = insertionSource + `  - role: builder
    name: worker
    cli: claude-code
    vendor: test
    model: "Test: Model"
    version: "1"
    launch: claude
    count: 2
`;
  expect(validateTeamFile(source).ok).toBe(true);
  const edited = rewriteCount(source, 'worker'); expect(edited).not.toBeNull();
  const read = validateTeamFile(edited!);
  expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
  if (read.ok) expect(read.team.seats.find(seat => seat.name === 'worker-2')?.label).toBe('test: model 1-2');
});
test('an inserted model field keeps punctuation in its value as text', () => {
  expect(validateTeamFile(insertionSource).ok).toBe(true);
  const edited = rewriteSeatModel(insertionSource, 'lead', {
    cli: 'claude-code', vendor: 'test', model: 'Test: Model', version: '1', display: 'Test: Model 1', launch: 'claude',
  });
  const read = validateTeamFile(edited);
  expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
  if (read.ok) expect(read.team.seats[0]?.display).toBe('Test: Model 1');
});
