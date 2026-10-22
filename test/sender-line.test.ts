// The `sender-line` policy: a typed wake's first line names the message's sender. The line's
// words now come from the `message-display` template (the shipped default names the seat and the
// team), and a legacy `sender-line` format is read as that template. The policy stays enforced —
// `off` is refused, so the format decides the words and never whether the name is there — and a
// chain that cannot be read leaves the shipped template, never an unnamed wake.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import { getPolicySpec, normalizePolicyName, resolvePolicy, writePolicySet } from '../src/policy/index.ts';
import { readTriggerLine, TRIGGER_MAX, triggerLine } from '../src/send/native.ts';
import { MESSAGE_LINE_MAX } from '../src/settings/message-display.ts';
import {
  parseSenderLineValue,
  renderSenderLine,
  senderLineFormatOf,
  senderLineValueProblem,
  SENDER_LINE_DEFAULT,
  SENDER_LINE_ON,
} from '../src/settings/sender-line.ts';
import { senderLineFormatInForce } from '../src/settings/sender-line-policy.ts';

const NOW = new Date('2026-10-19T21:00:00Z');

const TEAM = `format: 1
project: acme
entity: lab
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sender-line-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEAM);
  return { home, root };
}

describe('the sender-line catalogue entry', () => {
  test('is enforced at entity, project or team, and ships on', () => {
    const spec = getPolicySpec('sender-line');
    expect(spec).not.toBeNull();
    expect(spec?.kind).toBe('enforced');
    expect(spec?.levels).toEqual(['entity', 'project', 'team']);
    expect(spec?.defaultValue).toBe(SENDER_LINE_ON);
    expect(spec?.defaultValue).toBe('on');
    expect(spec?.gateLifting).toBe(false);
    // The snake_case file spelling names the same policy.
    expect(normalizePolicyName('sender_line')).toBe('sender-line');
  });

  test('absent, it resolves on; a lower level may choose its own format', () => {
    const absent = resolvePolicy('sender-line', []);
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.effective.value).toBe('on');
      expect(absent.effective.level).toBe('default');
    }
    const chosen = resolvePolicy('sender-line', [
      { name: 'sender-line', value: 'on', level: 'entity', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
      { name: 'sender-line', value: '{team} -> {seat}:', level: 'team', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
    ]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) {
      expect(chosen.effective.value).toBe('{team} -> {seat}:');
      expect(chosen.effective.level).toBe('team');
    }
  });

  test('refuses off and any format that does not name both the seat and the team', () => {
    const refusalsOf = (value: unknown) => {
      const result = resolvePolicy('sender-line', [
        { name: 'sender-line', value: value as string, level: 'team', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusals).toHaveLength(1);
        const first = result.refusals[0];
        expect(first?.kind).toBe('invalid-policy');
        return first?.kind === 'invalid-policy' ? first.why : undefined;
      }
      return undefined;
    };
    expect(refusalsOf('off')).toContain('cannot be turned off');
    expect(refusalsOf('hello')).toContain('must name both {seat} and {team}');
    expect(refusalsOf('{seat} only:')).toContain('must name both {seat} and {team}');
    expect(refusalsOf('{seat} {team} {model}:')).toContain('may use only the {seat} and {team} slots');
    expect(refusalsOf('two\nlines {seat} {team}')).toContain('one non-empty line');
  });
});

describe('the sender-line vocabulary', () => {
  test('parses on and a one-line format with both slots, and trims the format', () => {
    expect(parseSenderLineValue('on')).toBe('on');
    expect(parseSenderLineValue(true)).toBe('on');
    expect(parseSenderLineValue('  on  ')).toBe('on');
    expect(parseSenderLineValue('{team} -> {seat}:')).toBe('{team} -> {seat}:');
    expect(parseSenderLineValue('  {seat}@{team}:  ')).toBe('{seat}@{team}:');
    expect(parseSenderLineValue('From {seat}@{team}:')).toBe('From {seat}@{team}:');
  });

  test('rejects off, a missing slot, an unknown slot, a second line and a non-string', () => {
    for (const bad of ['off', 'false', false, '', '  ', 'From {seat}:', 'From {team}:', '{seat} {team} {x}', 'a\nb {seat} {team}', 1, null, undefined, ['on']]) {
      expect(parseSenderLineValue(bad)).toBeNull();
    }
    expect(senderLineValueProblem('off')).toContain('floor');
    expect(senderLineValueProblem(false)).toContain('floor');
    expect(senderLineValueProblem('From {seat}:')).toContain('both {seat} and {team}');
    expect(senderLineValueProblem('{seat} {team} {x}')).toContain('only');
    expect(senderLineValueProblem('a\nb {seat} {team}')).toContain('one non-empty line');
    expect(senderLineValueProblem(9)).toContain('must be "on"');
    expect(senderLineValueProblem('{seat}@{team}:')).toBeNull();
  });

  test('on and an unreadable value are the shipped format', () => {
    expect(senderLineFormatOf('on')).toBe(SENDER_LINE_DEFAULT);
    expect(senderLineFormatOf(undefined)).toBe(SENDER_LINE_DEFAULT);
    expect(senderLineFormatOf('off')).toBe(SENDER_LINE_DEFAULT);
    expect(senderLineFormatOf('{team} -> {seat}:')).toBe('{team} -> {seat}:');
  });

  test('renders the signed sender into both slots, every time they appear', () => {
    expect(renderSenderLine(SENDER_LINE_DEFAULT, { seat: 'owner', team: 'acme' })).toBe('From owner@acme:');
    expect(renderSenderLine('{seat}@{team} ({seat} of {team}):', { seat: 'the launch', team: 'acme' })).toBe(
      'the launch@acme (the launch of acme):',
    );
  });
});

describe('the format in force', () => {
  test('is the shipped format when the team declares none', () => {
    const { home, root } = world();
    const team = validateTeamFile(TEAM);
    if (!team.ok) throw new Error(JSON.stringify(team.errors));
    expect(senderLineFormatInForce({ home, root, team: team.team, now: NOW })).toBe(SENDER_LINE_DEFAULT);
  });

  test('is the signed team-level format when one is declared', () => {
    const { home, root } = world();
    const wrote = writePolicySet(
      home,
      { level: 'team', target: root, teamRoot: root, name: 'sender-line', value: '{team} -> {seat}:' },
      { now: NOW },
    );
    if (!wrote.ok) throw new Error(wrote.why);
    const team = validateTeamFile(TEAM);
    if (!team.ok) throw new Error(JSON.stringify(team.errors));
    expect(senderLineFormatInForce({ home, root, team: team.team, now: NOW })).toBe('{team} -> {seat}:');
  });

  test('a signed off is refused before it is written', () => {
    const { home, root } = world();
    const refused = writePolicySet(
      home,
      { level: 'team', target: root, teamRoot: root, name: 'sender-line', value: 'off' },
      { now: NOW },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('floor');
  });
});

describe('the builders read the format', () => {
  test('a custom format replaces the shipped opening and keeps both signed names', () => {
    const sender = { seat: 'owner', team: 'acme', format: '{team} -> {seat}:' };
    // A legacy `sender-line` format is read as a `message-display` template: the fixed read
    // hint follows it, and the line is never a command of its own.
    expect(triggerLine('/drops/x', sender)).toBe('acme -> owner: Read it at /drops/x.');
    expect(readTriggerLine('lead', 'acme', sender)).toBe(
      'acme -> owner: Read it with: team drops --read.',
    );
    // No format is the shipped `message-display` template.
    expect(readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme' })).toBe(
      'Message from owner (owner@acme): Read it with: team drops --read.',
    );
  });

  test('a long format is cut to one line, never a nameless one', () => {
    const long = { seat: 'owner', team: 'acme', format: `${'x'.repeat(200)} {seat}@{team}:` };
    const staged = triggerLine('/drops/x', long) as string;
    expect(staged.includes('\n')).toBe(false);
    expect(staged.length).toBeLessThanOrEqual(TRIGGER_MAX);
    expect(staged.startsWith('xxxx')).toBe(true);
    expect(staged.endsWith('Read it at /drops/x.')).toBe(true);
    const wake = readTriggerLine('lead', 'acme', long) as string;
    expect(wake.includes('\n')).toBe(false);
    expect(wake.length).toBeLessThanOrEqual(MESSAGE_LINE_MAX);
    expect(wake.startsWith('xxxx')).toBe(true);
    expect(wake.endsWith('Read it with: team drops --read.')).toBe(true);
    // A format cannot smuggle a second line into the wake: line safety replaces the break.
    const broken = { seat: 'owner', team: 'acme', format: 'From {seat}@\r{team}:' };
    expect((triggerLine('/drops/x', broken) as string).includes('\r')).toBe(false);
    expect((readTriggerLine('lead', 'acme', broken) as string).includes('\r')).toBe(false);
  });
});
