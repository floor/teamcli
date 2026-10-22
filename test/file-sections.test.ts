import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { approvalDifferences } from '../src/approve/approval.ts';
import { OWNER_SECTIONS } from '../src/approve/fingerprint.ts';
import { SECTIONS } from '../src/file/sections/index.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval, type ApprovalRecord } from '../src/store/store.ts';

// The owner-only sections are generated from the section modules now; this is the list the
// modules replaced, and the order is part of the contract: the approval digest reads the
// sections in it, so a reordered list would change what a difference report says first.
test('the generated owner sections equal the hand-kept list, in order', () => {
  expect(OWNER_SECTIONS).toEqual([
    'trust',
    'limits',
    'machine',
    'rules',
    'identity',
    'workspace',
    'orchestrator',
    'operator',
    'session',
    'visibility',
    'tools',
    'budgets',
    'watch',
    'watch.checks',
    // The digests of the sections before `tasks`, and the order a difference report prints them
    // in, are the ones records were written with. `grant` sits immediately before `delegates`,
    // so `delegates` stays last.
    'tasks',
    'tempo',
    'installer',
    'clients',
    'grant',
    'delegates',
  ]);
});

// Every `after` names a section there is, and none waits on itself: a typo would silently run a
// section before its input exists, so the list checks itself.
test('each section waits only on sections that exist', () => {
  const names = new Set(SECTIONS.map((section) => section.name));
  for (const section of SECTIONS) {
    for (const after of section.after) {
      expect(names.has(after)).toBe(true);
    }
    expect(section.after).not.toContain(section.name);
  }
});

// The file the section tests here validate.
const TEAM = `format: 1
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
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
`;

// `tasks.cadence` is a measured duration with its unit written: the value lifts to seconds, an
// omitted key stays off the parsed section, and a value the measure cannot read — a quoted one
// included — refuses with the sentence the validator prints.
test('tasks.cadence is a measured duration, and omission stays omission', () => {
  const plain = validateTeamFile(TEAM);
  if (!plain.ok) throw new Error('the fixture does not validate');
  expect(plain.team.tasks).toEqual({ source: 'file', path: '.agents/tasks.yaml' });
  const lifted = validateTeamFile(`${TEAM}  cadence: 10m\n`);
  if (!lifted.ok) throw new Error('the cadence fixture does not validate');
  expect(lifted.team.tasks).toEqual({ source: 'file', path: '.agents/tasks.yaml', cadence: 600 });
  for (const bad of ['10minutes', '"10m"', 'always']) {
    const checked = validateTeamFile(`${TEAM}  cadence: ${bad}\n`);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.errors.map((error) => error.message)).toContain(
        'tasks.cadence needs a value with its unit (s, m, h), such as 120s or 10m',
      );
    }
  }
  // A pause of zero is not a pause: a value that measures to zero refuses on the key's own line
  // — line 18, the appended cadence key — and it is the only problem. `120s` still lifts.
  for (const zero of ['0s', '0m', '0h', '0.0s']) {
    const checked = validateTeamFile(`${TEAM}  cadence: ${zero}\n`);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.errors).toEqual([{ line: 18, message: 'tasks.cadence must be greater than zero' }]);
    }
  }
  const positive = validateTeamFile(`${TEAM}  cadence: 120s\n`);
  if (!positive.ok) throw new Error('the 120s cadence fixture does not validate');
  expect(positive.team.tasks).toEqual({ source: 'file', path: '.agents/tasks.yaml', cadence: 120 });
});

// `budgets.check_every` is the other pause — the least gap between the check commands' runs.
// Zero refuses the same way, on its own line; a positive duration still parses.
test('budgets.check_every refuses a zero pause too', () => {
  const zeroed = validateTeamFile(`${TEAM}budgets:\n  check_every: 0s\n`);
  expect(zeroed.ok).toBe(false);
  if (!zeroed.ok) {
    expect(zeroed.errors).toEqual([{ line: 19, message: 'budgets.check_every must be greater than zero' }]);
  }
  const clean = validateTeamFile(`${TEAM}budgets:\n  check_every: 10m\n`);
  if (!clean.ok) throw new Error('the budgets fixture does not validate');
  expect(clean.team.budgets.checkEvery).toBe(600);
});

// `delivery_order` is the word on how a send to the team's seats walks. The file's own key and a
// seat's are read; the shape is checked here, and whether the word drops, reorders or would add
// a leg is the resolver's question, so a valid seat word may name legs the file's own word
// lacks. Omitted, the file reads null and the seat carries no field — the digests a file had.
describe('delivery_order', () => {
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  test('an omitted key reads null, and the seats carry no field', () => {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    expect(checked.team.deliveryOrder).toBeNull();
    expect('deliveryOrder' in (checked.team.seats[0] as object)).toBe(false);
  });

  test('the file’s own word and a seat’s are read, in the order written', () => {
    const checked = validateTeamFile(`${TEAM}delivery_order: [typed]\n`);
    if (!checked.ok) throw new Error('the delivery-order fixture does not validate');
    expect(checked.team.deliveryOrder).toEqual(['typed']);
    const seated = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    delivery_order: [native, typed]\n`));
    if (!seated.ok) throw new Error('the seat word fixture does not validate');
    expect(seated.team.seats[0]?.deliveryOrder).toEqual(['native', 'typed']);
    expect(seated.team.deliveryOrder).toBeNull();
  });

  test('drop is a leg the file and a seat may name, in its own position', () => {
    const checked = validateTeamFile(`${TEAM}delivery_order: [drop]\n`);
    if (!checked.ok) throw new Error('the drop fixture does not validate');
    expect(checked.team.deliveryOrder).toEqual(['drop']);
    const seated = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    delivery_order: [drop, typed]\n`));
    if (!seated.ok) throw new Error('the seat drop fixture does not validate');
    expect(seated.team.seats[0]?.deliveryOrder).toEqual(['drop', 'typed']);
  });

  test('a written key with no legs, an unknown leg and a repeated one are refused', () => {
    const cases = [
      { text: `${TEAM}delivery_order: []\n`, message: 'delivery_order needs at least one leg: socket, native, mcp-inbox, typed, drop, headless-resume' },
      { text: `${TEAM}delivery_order:\n`, message: 'delivery_order needs at least one leg: socket, native, mcp-inbox, typed, drop, headless-resume' },
      { text: `${TEAM}delivery_order: [telepathy]\n`, message: 'delivery_order "telepathy" must be one of: socket, native, mcp-inbox, typed, drop, headless-resume' },
      { text: `${TEAM}delivery_order: [typed, typed]\n`, message: 'delivery_order names "typed" twice' },
    ];
    for (const one of cases) {
      const checked = validateTeamFile(one.text);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.errors.map((error) => error.message)).toEqual([one.message]);
    }
  });

  test('a seat’s word is refused under the seat’s name', () => {
    const checked = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    delivery_order: [typed, typed]\n`));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.map((error) => error.message)).toEqual(['seat "lead": delivery_order names "typed" twice']);
  });
});

// `human` marks a pane a person uses: read as a flag on the seat, part of the built seat, and
// omitted when the file marks no seat — every file that marks none keeps the digest it had.
describe('human', () => {
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  test('an omitted key reads no field, false reads no field, and true reads the mark', () => {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    expect('human' in (checked.team.seats[0] as object)).toBe(false);
    const off = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    human: false\n`));
    if (!off.ok) throw new Error('the human: false fixture does not validate');
    expect('human' in (off.team.seats[0] as object)).toBe(false);
    const marked = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    human: true\n`));
    if (!marked.ok) throw new Error('the human fixture does not validate');
    expect(marked.team.seats[0]?.human).toBe(true);
  });

  test('a value that is not an unquoted flag is refused under the seat', () => {
    for (const value of ['yes', '"true"', '1']) {
      const checked = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    human: ${value}\n`));
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.errors.map((error) => error.message)).toEqual(['seat "lead": human must be true or false']);
    }
  });
});

// `inbound` is a seat's own word on cross-session socket frames: the TeamCLI side of the decision
// a send reads beside the launch's own `crossSessionInbound` declaration. Omitted, the seat
// carries no field and its digest is the one it had; writing one is an edit the owner re-approves.
describe('inbound', () => {
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  test('an omitted key reads no field, and each word is read as written', () => {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    expect('inbound' in (checked.team.seats[0] as object)).toBe(false);
    for (const word of ['accept', 'hold', 'refuse'] as const) {
      const written = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    inbound: ${word}\n`));
      if (!written.ok) throw new Error(`the inbound: ${word} fixture does not validate`);
      expect(written.team.seats[0]?.inbound).toBe(word);
    }
  });

  test('a word outside the three is refused under the seat', () => {
    // A word is a word: quoting one is not refused, the way a flag's quoted `"true"` is.
    for (const value of ['yes', 'always']) {
      const checked = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    inbound: ${value}\n`));
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.errors.map((error) => error.message)).toEqual(['seat "lead": inbound must be one of: accept, hold, refuse']);
      }
    }
  });
});

// `liveness` is a seat's own word on the three liveness windows: each a positive number of
// seconds, under the same inheritance the watch's reports read. Omitted, the seat carries no
// field and its digest is the one it had; writing one is an edit the owner re-approves.
describe('liveness', () => {
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  test('an omitted map reads no field, and a written one reads the windows it names', () => {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    expect('liveness' in (checked.team.seats[0] as object)).toBe(false);
    const written = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    liveness:\n      idle_lead_seconds: 60\n      blind_after_seconds: 120\n`));
    if (!written.ok) throw new Error('the liveness fixture does not validate');
    expect(written.team.seats[0]?.liveness).toEqual({ idle_lead_seconds: 60, blind_after_seconds: 120 });
  });

  test('a map that is not one, an unknown key and a value that is not seconds are refused under the seat', () => {
    const cases = [
      {
        text: `${LEAD_LAUNCH}    liveness: soon\n`,
        message: 'seat "lead": liveness must be a map of thresholds',
      },
      {
        text: `${LEAD_LAUNCH}    liveness:\n      idle_first: 60\n`,
        message: 'seat "lead": liveness has no threshold "idle_first"; the keys are idle_lead_seconds, idle_owner_seconds, blind_after_seconds',
      },
      {
        text: `${LEAD_LAUNCH}    liveness:\n      blind_after_seconds: 0\n`,
        message: 'seat "lead": liveness "blind_after_seconds" must be a whole number of seconds, at least 1',
      },
      {
        text: `${LEAD_LAUNCH}    liveness:\n      blind_after_seconds: 1.5\n`,
        message: 'seat "lead": liveness "blind_after_seconds" must be a whole number of seconds, at least 1',
      },
    ];
    for (const one of cases) {
      const checked = validateTeamFile(TEAM.replace(LEAD_LAUNCH, one.text));
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.errors.map((error) => error.message)).toEqual([one.message]);
    }
  });
});

// An approval record written by main's code today (test/fixtures/approval-main.json, its
// fingerprints taken with main's own reader) still verifies the same file on this branch: the
// modules produce the digests main's monolith does. The record carries its own copy of the
// approved text, so the fixture is the proof.
describe('an approval written by main', () => {
  const root = '/flo632a/root';

  // The fixture is the file as main wrote it to the store: the approval's fields with the
  // approved text inside. `writeApproval` takes them apart, so the test puts them back together.
  function record(): ApprovalRecord {
    const { file, ...approval } = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/approval-main.json'), 'utf8'));
    // The capture is a real record from before records were signed; its fingerprints are the
    // point here, and they are read inside a record this version signs.
    return { approval: { ...approval, format: 2 }, file };
  }

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'team-sections-'));
    const source = record();
    const checked = validateTeamFile(source.file);
    if (!checked.ok) throw new Error('the approval fixture\'s copy does not validate; a behaviour change');
    const store = storePath(checked.team.project, root, dir);
    mkdirSync(store, { recursive: true });
    writeApproval(store, source, [], dir);
    return dir;
  }

  test('still verifies the file it approved', () => {
    const where = home();
    const checked = validateTeamFile(record().file);
    if (!checked.ok) throw new Error('unreachable: home() validated the same text');
    expect(approvalDifferences(checked.team, root, where)).toEqual([]);
  });

  // The record's sections map was written by a reader that called the lead's bucket
  // `coordinator`; this reader compares `orchestrator`. The bucket the record lacks is
  // refilled from the copy the record stores, so rewriting the file to the mark — the
  // conversion a team will run once the key is gone — prints no line and needs no new
  // approval.
  test('a conversion to the mark prints no difference', () => {
    const where = home();
    const converted = record().file
      .replace('coordinator: coordinator-seat\n', '')
      .replace('    name: coordinator-seat\n', '    name: coordinator-seat\n    leads: true\n');
    const checked = validateTeamFile(converted);
    if (!checked.ok) throw new Error('the converted fixture does not validate; a behaviour change');
    expect(checked.team.orchestrator).toBe('coordinator-seat');
    expect(approvalDifferences(checked.team, root, where)).toEqual([]);
  });

  test('a lead move is the `orchestrator` difference', () => {
    const where = home();
    const checked = validateTeamFile(record().file.replace('coordinator: coordinator-seat', 'coordinator: operator-seat'));
    if (!checked.ok) throw new Error('the moved fixture does not validate; a behaviour change');
    expect(approvalDifferences(checked.team, root, where)).toEqual(['`orchestrator` changed']);
  });

  test('and the comparison is live: a watch edit still reads as a difference', () => {
    const where = home();
    const checked = validateTeamFile(record().file.replace('interval: 2m', 'interval: 5m'));
    if (!checked.ok) throw new Error('the edited fixture does not validate');
    expect(approvalDifferences(checked.team, root, where)).toEqual(['`watch` changed']);
  });
});

// `sender_name` is the word on how a sender reads in TeamCLI's headlines. The file's own key and
// a seat's are read — the same two places the delivery order is written — and the four words are
// the ones the resolver reads. It is presentation, not permission: omitted, the file reads null
// and the seat carries no field, so the digests a file had are unchanged.
describe('sender_name', () => {
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  test('an omitted key reads null, and the seats carry no field', () => {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    expect(checked.team.senderName).toBeNull();
    expect('senderName' in (checked.team.seats[0] as object)).toBe(false);
  });

  test('the file’s own word and a seat’s are read, in the order written', () => {
    for (const word of ['auto', 'nickname', 'seat', 'seat@team'] as const) {
      const checked = validateTeamFile(`${TEAM}sender_name: ${word}\n`);
      if (!checked.ok) throw new Error(`the ${word} fixture does not validate`);
      expect(checked.team.senderName).toBe(word);
      expect(checked.team.seats[0]?.senderName).toBeUndefined();
    }
    const seated = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    sender_name: seat@team\n`));
    if (!seated.ok) throw new Error('the seat word fixture does not validate');
    expect(seated.team.seats[0]?.senderName).toBe('seat@team');
    expect(seated.team.senderName).toBeNull();
  });

  test('a word this build cannot read refuses, naming the four it reads', () => {
    const file = validateTeamFile(`${TEAM}sender_name: full\n`);
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.errors.map((error) => error.message)).toContain('sender_name must be one of: auto, nickname, seat, seat@team');
    const seat = validateTeamFile(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    sender_name: full\n`));
    expect(seat.ok).toBe(false);
    if (!seat.ok) {
      expect(seat.errors.map((error) => error.message)).toContain('seat "lead": sender_name must be one of: auto, nickname, seat, seat@team');
    }
  });
});
