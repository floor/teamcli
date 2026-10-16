// `effort`, the optional per-seat field accepted softly: parsed and carried on the seat, warned
// about when its word is outside its lab's list, and never the reason a `team check`, `team
// approve` or `team up` fails. The words a lab allows live in the versioned data file
// src/profiles/efforts.json (format 1, keyed by the seat's vendor, loaded by the one module
// src/profiles/efforts.ts), and each list is words that lab's own CLI help printed — a lab whose
// help names none is left out, and a vendor with no entry accepts any word. A vocabulary this
// build cannot read is itself only a warning: a bad data file must not fail every existing team
// file, none of which can contain `effort` (an unknown field already refused them).
//
// The label is not this change's to test: `effort` reaching the herdr title is the derived-label
// change's coverage, in test/seat-label.test.ts.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runApprove } from '../src/approve/command.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { parseEfforts, shippedEfforts } from '../src/profiles/efforts.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-12T12:00:00Z');

// The shipped vocabulary, read as data so a later word list only moves the literals, never the
// shape of these tests. `anthropic` and `google` are the labs whose own help printed words.
const shippedFile = readFileSync(new URL('../src/profiles/efforts.json', import.meta.url), 'utf8');
const covered = Object.entries((JSON.parse(shippedFile) as { labs: Record<string, string[]> }).labs)
  .find(([, words]) => words.length > 0);
if (!covered) throw new Error('the shipped efforts file names no lab with a word');
const [lab, words] = covered;

const cliOf: Record<string, string> = { anthropic: 'claude-code', google: 'antigravity' };

const seatOf = (vendor: string, effort: string | undefined) => `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: ${cliOf[vendor] ?? 'claude-code'}
    vendor: ${vendor}
    model: Some Model
    version: "1"
${effort === undefined ? '' : `    effort: ${effort}\n`}    launch: claude
`;

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result;
}

describe('the efforts vocabulary file', () => {
  test('is versioned, and the loader reads the version it knows', () => {
    expect(shippedEfforts()).toEqual(parseEfforts(JSON.parse(shippedFile)));
    expect(shippedEfforts()).toMatchObject({ ok: true, format: 1 });
    const refused = parseEfforts({ format: 2, labs: {} });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/format is 2.*this build reads 1/);
  });

  test('a document this build cannot read is refused by the parser, not by the file', () => {
    for (const bogus of [null, [], { format: 1 }, { format: 1, labs: 'xai' }, { format: 1, labs: { xai: 'high' } }]) {
      const refused = parseEfforts(bogus);
      expect(refused.ok).toBe(false);
    }
  });
});

describe('a seat\'s effort', () => {
  test('inside its lab\'s vocabulary is accepted without a word', () => {
    const { team, warnings } = valid(seatOf(lab, words[0]));
    expect(team.seats[0]?.effort).toBe(words[0]);
    expect(warnings.some((warning) => warning.message.includes('effort'))).toBe(false);
  });

  test('outside its lab\'s vocabulary is a warning naming the lab\'s words, and check, approve and up still succeed', async () => {
    const bogus = 'definitely-not-an-effort-word';
    expect(words).not.toContain(bogus);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-effort-')));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    // The file as it runs: with the trust block `up` needs, so its line numbers are the ones the
    // commands print.
    const text = seatOf(lab, bogus).replace('workspace:', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:`);
    writeFileSync(join(root, '.agents/team.yaml'), text);
    const loaded = validateTeamFile(text);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.team.seats[0]?.effort).toBe(bogus);
    const message = loaded.warnings.map((warning) => warning.message).join('\n');
    expect(message).toContain(`effort "${bogus}" is not one of ${lab}'s:`);
    for (const word of words) expect(message).toContain(word);
    const line = loaded.warnings.find((warning) => warning.message.includes('effort'))?.line;
    const team = loaded.team;

    // The file-invalid exit is 2; an unlaunched team always has its ordinary differences (the
    // seat is not running yet), so the claim is the exit the file's shape decides — and that no
    // line of the answer is about the effort.
    const check = testIo(root, { kind: 'owner' });
    expect(runTeamCheck({ file: '.agents/team.yaml' }, check, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    }), `${check.out}${check.err}`).not.toBe(2);
    expect(`${check.out}${check.err}`).not.toContain('effort');

    const approve = testIo(root, { kind: 'owner' });
    expect(await runApprove(['--file', '.agents/team.yaml'], approve, {
      ask: async () => null,
      waiting: () => 'empty',
      now: () => NOW,
      home,
    }), `${approve.out}${approve.err}`).toBe(0);
    expect(approve.err).toContain(`warning, line ${line}: seat "lead": effort "${bogus}" is not one of ${lab}'s: ${words.join(', ')}`);

    expect(approvalDifferences(team, root, home)).toEqual([]);
    const up = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run', '--file', '.agents/team.yaml'], up, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctorSources(home),
    } satisfies Partial<UpSources> as UpSources), `${up.out}${up.err}`).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test('on a lab the file has no entry for accepts any word', () => {
    // `xai` is one of the labs left out: its CLI's help names the flag and lists no words, so
    // the vocabulary leaves it out rather than inventing a list for it.
    const { team, warnings } = valid(seatOf('xai', 'turbo'));
    expect(team.seats[0]?.effort).toBe('turbo');
    expect(warnings.some((warning) => warning.message.includes('effort'))).toBe(false);
  });

  test('left out, nothing changes for the seat', () => {
    const { team, warnings } = valid(seatOf(lab, undefined));
    expect(team.seats[0]?.effort).toBeUndefined();
    expect(warnings.some((warning) => warning.message.includes('effort'))).toBe(false);
  });

  test('a vocabulary this build cannot read warns, and the file still loads', () => {
    // The regression this guards: a bad data file fails no file. The vocabulary is read only
    // once a seat sets the field, so the shipped file is replaced for the length of one load
    // and put back: a seat with the field gets the warning and keeps its word, and a file that
    // sets none does not even open the vocabulary.
    const shipped = new URL('../src/profiles/efforts.json', import.meta.url);
    const backup = readFileSync(shipped, 'utf8');
    try {
      writeFileSync(shipped, '{"format": 2, "labs": {}}');
      const withEffort = valid(seatOf(lab, words[0]));
      expect(withEffort.team.seats[0]?.effort).toBe(words[0]);
      expect(withEffort.warnings.some((warning) => warning.message.includes('effort vocabulary format is 2; this build reads 1'))).toBe(true);
      const without = valid(seatOf(lab, undefined));
      expect(without.warnings.some((warning) => warning.message.includes('effort vocabulary'))).toBe(false);
    } finally {
      writeFileSync(shipped, backup);
    }
  });

  test('a vocabulary file that is missing, or is not JSON, warns the same way', () => {
    // The loader's two unreadable branches, distinct from a readable-but-refused document:
    // the read itself throws (the file is renamed away for the length of one load), or the
    // bytes do not parse. Either way the word stays on the seat and the file still loads —
    // a missing data file must not fail teams whose seats set no effort either.
    const shipped = new URL('../src/profiles/efforts.json', import.meta.url);
    const aside = new URL('../src/profiles/efforts.json.aside', import.meta.url);
    renameSync(shipped, aside);
    try {
      const missing = valid(seatOf(lab, words[0]));
      expect(missing.team.seats[0]?.effort).toBe(words[0]);
      expect(missing.warnings.some((warning) => /effort vocabulary could not be read:.*ENOENT/.test(warning.message))).toBe(true);
      const untouched = valid(seatOf(lab, undefined));
      expect(untouched.warnings.some((warning) => warning.message.includes('effort vocabulary'))).toBe(false);
    } finally {
      renameSync(aside, shipped);
    }
    const backup = readFileSync(shipped, 'utf8');
    try {
      writeFileSync(shipped, 'not json');
      const unparsable = valid(seatOf(lab, words[0]));
      expect(unparsable.team.seats[0]?.effort).toBe(words[0]);
      expect(unparsable.warnings.some((warning) => warning.message.startsWith('effort vocabulary is not JSON:'))).toBe(true);
    } finally {
      writeFileSync(shipped, backup);
    }
  });
});

describe('the approval key of a seat', () => {
  // The same seat test/seat-label.test.ts pins a digest for, spelled identically so the pinned
  // literal below — the one the code at origin/main (89e0dfe) wrote — stays its key: with no
  // effort the field is absent from the seat, so `seatDigest` hashes the fields it always did.
  // Whether the word is in a lab's list changes nothing here: the key claim is absence versus
  // presence.
  const digestSeat = (effort: string | undefined) => `format: 1
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
${effort === undefined ? '' : `    effort: ${effort}\n`}    launch: claude --model claude-opus-5-5
`;
  const DIGEST_WITHOUT_EFFORT = '9680f5f846ed89d816396590ff3883fd44ce864808fabd4c91a0482350db8c1a';

  test('without an effort keeps the key it always had', () => {
    expect(fingerprints(valid(digestSeat(undefined)).team).seats.lead).toBe(DIGEST_WITHOUT_EFFORT);
  });

  test('with an effort, in or out of the list, is a different key', () => {
    const withEffort = fingerprints(valid(digestSeat('high')).team).seats.lead;
    const outOfList = fingerprints(valid(digestSeat('definitely-not-an-effort-word')).team).seats.lead;
    expect(withEffort).not.toBe(DIGEST_WITHOUT_EFFORT);
    expect(outOfList).not.toBe(DIGEST_WITHOUT_EFFORT);
    expect(withEffort).not.toBe(outOfList);
  });
});

function doctorSources(home: string) {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}
