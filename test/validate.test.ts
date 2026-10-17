import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTeamFile } from '../src/file/validate.ts';
import { renderSignature } from '../src/file/signature.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

const minimal = `format: 1
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
`;

// The notice a file spelled with the legacy `coordinator:` key carries, at line 3 of `minimal`.
// Files keep the old spelling on purpose — it is still read — so they warn.
const notice = {
  line: 3,
  message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
  repair: "set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml",
};

// Replaces one piece of a valid file, and fails loudly if the piece isn't there.
function change(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`the fixture has no "${from}"`);
  return text.replace(from, to);
}

function errors(text: string, options: { home?: string; root?: string } = {}): string[] {
  const result = validateTeamFile(text, options);
  if (result.ok) return [];
  return result.errors.map((problem) => `${problem.line}: ${problem.message}`);
}

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result;
}

test('an absolute trust path is a folder entry', () => {
  expect(valid(`${minimal}trust:\n  - /srv/lobby\n`).team.trust).toEqual(['/srv/lobby']);
});

describe('the complete example of the RFC', () => {
  const { team, warnings } = valid(example);

  test('is accepted, carrying only the legacy key\'s notice', () => {
    expect(warnings).toEqual([{ ...notice, line: 5 }]);
    expect(team.format).toBe(1);
    expect(team.visibility).toBe('public');
  });

  test('count is expanded, and an omitted label is the model and version', () => {
    expect(team.seats.map((seat) => seat.name)).toEqual([
      'claude-coordinator-acme', 'codex-acme', 'deepseek-acme', 'deepseek-acme-2', 'grok-acme',
    ]);
    expect(team.seats.map((seat) => seat.label)).toEqual([
      'claude opus 5.5', 'gpt sol 6', 'deepseek flash v4.1', 'deepseek flash v4.1-2', 'grok 4.7',
    ]);
    expect(team.seats[3]).toMatchObject({ label: 'deepseek flash v4.1-2', declared: 'deepseek-acme', instance: 2, count: 2 });
  });

  test('defaults are applied to seats', () => {
    const [lead, codex, , , grok] = team.seats;
    expect(lead).toMatchObject({ display: 'Claude Opus 5.5', cwd: '.', mode: 'shared', label: 'claude opus 5.5', parked: false });
    expect(codex).toMatchObject({ display: 'GPT-6 Sol', mode: 'worktree', parked: true });
    expect(grok).toMatchObject({ stopped: true, cli: 'grok', vendor: 'xai' });
  });

  test('identity: templates, positions, exemptions, and the defaults before the file\'s patterns', () => {
    expect(team.identity.signature.commits).toEqual({ template: 'Agent: {display} · {role}', position: 'trailer', exempt: ['merge'] });
    expect(team.identity.signature.pullRequests).toEqual({ template: '**Agent:** {display} · {role}', position: 'last-line' });
    expect(team.identity.forbidden).toEqual(['^Claude-Session:', 'https?://claude\\.ai/code/session']);
    expect(team.identity.forbiddenPublic).toEqual(['\\bWEB-[0-9]+\\b']);
    expect(team.identity.humans).toEqual(['jane@acme.example']);
    expect(team.identity.since).toBe('4f2a9c1');
  });

  test('values with units are read into seconds, percent and bytes', () => {
    expect(team.watch).toMatchObject({ interval: 120, idleFirst: 600, idleRepeat: 1200, unsentAfter: 60, quotaMarks: [50, 75, 90] });
    expect(team.machine).toEqual({
      loadStart: 3, loadMax: 6, memoryStart: 25, memoryMin: 15, diskMin: 10e9,
      swapFreeMin: 2e9, swapGrowthMax: 1e9, swapGrowthWindow: 600,
    });
    expect(team.limits).toEqual({ seats: 6, temporary: 2, vendors: { openai: 1, deepseek: 3 } });
  });

  test('a signature renders in the vendor\'s spelling', () => {
    const codex = team.seats[1];
    if (!codex) throw new Error('no seat');
    expect(renderSignature(team.identity.signature.commits.template, codex)).toBe('Agent: GPT-6 Sol · implementer');
  });
});

describe('a minimal file', () => {
  const { team } = valid(minimal);
  test('gets every default', () => {
    expect(team.session).toBe('acme');
    expect(team.visibility).toBe('private');
    expect(team.identity.signature.commits.position).toBe('trailer');
    expect(team.identity.signature.commits.exempt).toEqual(['merge']);
    expect(team.identity.since).toBeNull();
    expect(team.workspace).toMatchObject({ mode: 'shared', branch: '{task}', remove: 'on-merge', protected: ['.'], limit: 8 });
    expect(team.limits).toEqual({ seats: 3, temporary: 2, vendors: {} });
    expect(team.watch.nudgeWait).toBe(600);
    expect(team.watch.idleRepeat).toBeUndefined();
  });
  test('is public when it only sets forbidden_public', () => {
    const text = `${minimal}identity:\n  forbidden_public: ["\\\\bX-[0-9]+"]\n`;
    expect(valid(text).team.visibility).toBe('public');
  });
});

// The lead's two spellings: the `coordinator:` key above, still read, and `leads: true` on
// exactly one seat. `bare` drops the key and moves the operator to a second seat, so a
// derivation's only refusal is the lead's own. `marked` puts the mark after the lead's launch.
const workerSeat = `  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;
const bare = `${change(change(minimal, 'coordinator: lead\n', ''), 'operator: lead', 'operator: worker')}${workerSeat}`;
const marked = change(bare, '    launch: claude --model claude-opus-5-5\n', '    launch: claude --model claude-opus-5-5\n    leads: true\n');

describe('the lead is a field, or the legacy key', () => {
  test('a marked file needs no key, and carries no notice', () => {
    const { team, warnings } = valid(marked);
    expect(team.orchestrator).toBe('lead');
    expect(warnings).toEqual([]);
  });

  test('a file with neither spelling is refused at its first line', () => {
    expect(errors(bare)).toEqual(['1: the file has no seat that leads: put `leads: true` on one seat']);
  });

  test('two marks are refused at the second one', () => {
    // `marked` carries the lead's mark on line 14 and the worker seat on 15..21, so the second
    // mark lands on line 22.
    const twice = change(marked, '    launch: codex\n', '    launch: codex\n    leads: true\n');
    expect(errors(twice)).toEqual(['22: `leads` is on 2 seats: "lead", "worker"; a team has one lead']);
  });

  test('the key alone still reads, with its own refusals', () => {
    const { team, warnings } = valid(minimal);
    expect(team.orchestrator).toBe('lead');
    expect(warnings).toEqual([notice]);
    expect(errors(change(minimal, 'coordinator: lead', 'coordinator: boss'))).toEqual(['3: coordinator "boss" names no declared seat']);
  });

  test('the key beside a mark on the same seat is the one team', () => {
    const both = change(minimal, '    launch: claude --model claude-opus-5-5\n', '    launch: claude --model claude-opus-5-5\n    leads: true\n');
    const { team, warnings } = valid(both);
    expect(team.orchestrator).toBe('lead');
    expect(warnings).toEqual([notice]);
  });

  test('the key and a mark on another seat are refused at the key', () => {
    // The key is on line 3, the mark on `worker` on line 22.
    expect(errors(`${minimal}${workerSeat}    leads: true\n`)).toEqual([
      '3: `coordinator:` names lead and `leads` is on worker: a file names one lead',
    ]);
  });

  test('a marked seat that cannot lead is refused in the mark\'s spelling, key or no key', () => {
    // Inserted before the lead's launch, the mark lands on line 15 of `marked`.
    const refused = (field: string) =>
      errors(change(marked, '    launch: claude --model claude-opus-5-5\n', `${field}\n    launch: claude --model claude-opus-5-5\n`));
    expect(refused('    parked: true')).toEqual(['15: `leads` on "lead" can\'t be a parked seat']);
    expect(refused('    stopped: true')).toEqual(['15: `leads` on "lead" can\'t be a stopped seat']);
    expect(refused('    count: 2')).toEqual(['15: `leads` on "lead" can\'t be a seat with count']);
    // Beside the key, the marked seat's refusal does not let the key pick another seat: the
    // operator stands clear of both, so both lines are the lead's.
    const parkedWorker = change(workerSeat, '    launch: codex\n', '    parked: true\n    launch: codex\n');
    const apart = errors(`${minimal}${parkedWorker}    leads: true\n`);
    expect(apart).toEqual([
      '3: `coordinator:` names lead and `leads` is on worker: a file names one lead',
      '23: `leads` on "worker" can\'t be a parked seat',
    ]);
  });

  test('a marked seat that is broken already adds no second complaint', () => {
    const found = errors(change(marked, '    vendor: anthropic\n', ''));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('vendor is required');
  });

  test('a quoted mark and `leads: false` read as no mark at all', () => {
    const quoted = change(marked, '    leads: true\n', '    leads: "true"\n');
    expect(errors(quoted)).toEqual([
      '1: the file has no seat that leads: put `leads: true` on one seat',
      '14: seat "lead": leads must be true or false',
    ]);
    const off = change(marked, '    leads: true\n', '    leads: false\n');
    expect(errors(off)).toEqual(['1: the file has no seat that leads: put `leads: true` on one seat']);
  });
});

// The entity's assistant: `assistant: true` on at most one seat, never on one the file expands
// from a count. Unlike the lead there is no key to spell it with, so the mark rides the built
// seat — the capability admits a send, and the seat's digest is what the owner approves.
describe('the assistant is one seat the file marks', () => {
  const mark = (text: string, at = '    launch: claude --model claude-opus-5-5\n'): string =>
    change(text, at, `${at}    assistant: true\n`);

  test('the mark rides the seat, and no other spelling is needed', () => {
    const { team, warnings } = valid(mark(marked));
    expect(team.seats.filter((seat) => seat.assistant === true).map((seat) => seat.name)).toEqual(['lead']);
    expect(warnings).toEqual([]);
  });

  test('a file that marks none carries no field at all', () => {
    const { team } = valid(marked);
    expect(team.seats.map((seat) => seat.assistant)).toEqual([undefined, undefined]);
  });

  test('two marks are refused at the second one', () => {
    // The lead's mark lands on line 14 in `marked`, which shifts the worker's seat down one; the
    // worker's mark lands on 23.
    expect(errors(mark(mark(marked), '    launch: codex\n'))).toEqual([
      '23: `assistant` is on more than one seat: a team has one assistant',
    ]);
  });

  test('a mark on a seat with a count is refused at the field', () => {
    // The worker is the operator in this fixture, so the operator moves to the lead's seat: the
    // count's own refusal would otherwise stand beside the assistant's.
    const moved = change(marked, 'operator: worker\n', 'operator: lead\n');
    const counted = change(moved, '    launch: codex\n', '    launch: codex\n    count: 2\n    assistant: true\n');
    expect(errors(counted)).toEqual(['23: `assistant` on "worker" can\'t be a seat with count']);
  });
});

const refusals: [string, string, RegExp][] = [
  ['no format', change(minimal, 'format: 1\n', ''), /format is required/],
  ['another format', change(minimal, 'format: 1', 'format: 2'), /format must be 1/],
  ['a quoted format', change(minimal, 'format: 1', 'format: "1"'), /format must be 1/],
  ['an unknown top-level field', `${minimal}colour: blue\n`, /unknown field "colour" in the file/],
  ['an unknown seat field', change(minimal, '    cli:', '    shell: zsh\n    cli:'), /unknown field "shell" in a seat/],
  ['a duplicate key', change(minimal, 'operator: lead', 'operator: lead\nproject: other'), /duplicate key "project"/],
  ['no project', change(minimal, 'project: acme\n', ''), /project is required/],
  ['no coordinator', change(minimal, 'coordinator: lead\n', ''), /the file has no seat that leads: put `leads: true` on one seat/],
  ['no operator', change(minimal, 'operator: lead\n', ''), /operator is required/],
  ['no seats', minimal.slice(0, minimal.indexOf('seats:')), /seats is required/],
  ['a coordinator that names no seat', change(minimal, 'coordinator: lead', 'coordinator: boss'), /coordinator "boss" names no declared seat/],
  ['a parked operator', `${minimal}    parked: true\n`, /operator "lead" can't be a parked seat/],
  ['a stopped coordinator', `${minimal}    stopped: true\n`, /coordinator "lead" can't be a stopped seat/],
  ['a coordinator with count', `${minimal}    count: 2\n`, /coordinator "lead" can't be a seat with count/],
  ['the session "default"', change(minimal, 'project: acme', 'project: acme\nsession: default'), /session can't be "default"/],
  ['a project named default with no session', change(minimal, 'project: acme', 'project: default'), /session can't be "default"/],
  ['an unquoted version', change(minimal, '"5.5"', '4.10'), /version must be quoted \("4\.10"\)/],
  ['a missing seat field', change(minimal, '    vendor: anthropic\n', ''), /vendor is required/],
  ['a missing launch', change(minimal, '    launch: claude --model claude-opus-5-5\n', ''), /launch is required/],
  ['an unknown cli', change(minimal, 'cli: claude-code', 'cli: emacs'), /cli must be one of: claude-code, codex, cursor, grok, antigravity/],
  ['a number where text is expected', change(minimal, 'role: coordinator', 'role: 7'), /role must be text/],
  ['a display without the version token', `${minimal}    display: Claude Opus 15.5\n`, /display must contain the version "5\.5" as a token/],
  ['an absolute cwd', `${minimal}    cwd: /srv/acme\n`, /cwd must be relative/],
  ['a home cwd', `${minimal}    cwd: ~/Code/acme\n`, /cwd must be relative/],
  ['a cwd outside the project and trust', `${minimal}    cwd: ../other\n`, /outside the project and matches no trust path/],
  ['a parked flag that is not a boolean', `${minimal}    parked: "yes"\n`, /parked must be true or false/],
  ['a count below 1', `${minimal}    count: 0\n`, /count must be a whole number, 1 or more/],
  ['an unknown mode', change(minimal, 'mode: shared', 'mode: both'), /workspace.mode must be one of: worktree, shared/],
  ['worktrees without a base', change(minimal, 'mode: shared', 'mode: worktree\n  path: ../wt/acme/{task}'), /workspace.base is required/],
  ['worktrees without a path', change(minimal, 'mode: shared', 'mode: worktree\n  base: main'), /workspace.path is required/],
  ['a duration without its unit', `${minimal}watch:\n  interval: 120\n`, /watch.interval needs a value with its unit \(s, m, h\)/],
  ['a memory figure without its unit', `${minimal}machine:\n  memory_start: 25\n`, /machine.memory_start needs a value with its unit \(%\)/],
  ['a size without its unit', `${minimal}machine:\n  disk_min: 10\n`, /machine.disk_min needs a value with its unit/],
  ['a swap figure without its unit', `${minimal}machine:\n  swap_free_min: 2\n`, /machine.swap_free_min needs a value with its unit \(MB, GB, TB\)/],
  ['a swap window without its unit', `${minimal}machine:\n  swap_growth_window: 10\n`, /machine.swap_growth_window needs a value with its unit \(s, m, h\)/],
  ['a load that is not a number', `${minimal}machine:\n  load_start: high\n`, /machine.load_start must be a number/],
  ['quota marks that are not percentages', `${minimal}watch:\n  quota_marks: [50, 150]\n`, /quota_marks must be a list of percentages/],
  ['a limit that is not a whole number', `${minimal}limits:\n  seats: 2.5\n`, /limits.seats must be a whole number/],
  ['a template without {role}', `${minimal}identity:\n  signature:\n    template: "Agent: {display}"\n`, /must contain \{role\}/],
  ['a template without the model', `${minimal}identity:\n  signature:\n    template: "Agent: {version} · {role}"\n`, /must contain \{display\}, or both \{model\} and \{version\}/],
  ['an unknown placeholder', `${minimal}identity:\n  signature:\n    template: "Agent: {display} · {role} {team}"\n`, /unknown placeholder \{team\}/],
  ['trailer with a template git can\'t read as one', `${minimal}identity:\n  signature:\n    template: "Signed by: {display} · {role}"\n`, /position "trailer" needs a template git reads as a trailer/],
  ['an unknown position', `${minimal}identity:\n  signature:\n    commits:\n      position: first-line\n`, /position must be one of: last-line, trailer, anywhere/],
  ['an exemption other than merge', `${minimal}identity:\n  signature:\n    commits:\n      exempt: [revert]\n`, /exempt takes only "merge"/],
  ['exempt on pull requests', `${minimal}identity:\n  signature:\n    pull_requests:\n      exempt: [merge]\n`, /pull_requests has no exempt/],
  ['a forbidden pattern that is no regular expression', `${minimal}identity:\n  forbidden: ["(open"]\n`, /identity.forbidden: not a regular expression/],
  ['an unknown visibility', `${minimal}visibility: secret\n`, /visibility must be one of: public, private/],
  ['a tool without a kind', `${minimal}tools:\n  tracker: { workspace: acme }\n`, /tools.tracker needs a kind/],
  ['a rule read as a map', `${minimal}rules:\n  - Never stop: keep working\n`, /each item of rules must be text: quote a line that contains ": "/],
  ['a trust pattern over the project\'s siblings', `${minimal}trust:\n  - ../*\n`, /would trust every folder beside the project/],
  ['a trust pattern over an ancestor', `${minimal}trust:\n  - ../..\n`, /is a parent of the project/],
  ['a star in the middle of a trust pattern', `${minimal}trust:\n  - ../*/acme\n`, /takes "\*" only as a whole last segment/],
  ['a partial star', `${minimal}trust:\n  - ../wt/acme-*\n`, /takes "\*" only as a whole last segment/],
  ['mixing legacy patterns and absolute paths', `${minimal}trust:\n  - .\n  - /srv\n`, /cannot mix legacy patterns and absolute paths/],
  ['a key with a known prefix', `${minimal}tools:\n  tracker: { kind: linear, token: lin_api_0123456789abcdefghij }\n`, /shaped like a key or token/],
  ['a URL with credentials', `${minimal}tools:\n  db: { kind: postgres, url: "postgres://admin:hunter2@db.example/acme" }\n`, /URL with credentials/],
  ['YAML outside the subset', change(minimal, 'project: acme', 'project: &p acme'), /anchors/],
];

describe('every refusal of § 2 names its line', () => {
  for (const [name, text, message] of refusals) {
    test(name, () => {
      const found = errors(text);
      expect(found.join('\n')).toMatch(message);
      for (const line of found) expect(line).toMatch(/^\d+: /);
    });
  }
});

describe('a relative entry in an otherwise migrated file', () => {
  test('is refused, and the entry is named at its line', () => {
    const found = errors(`${minimal}trust:\n  - ~/.config/team/lobby\n  - .\n`);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('trust: "~/.config/team/lobby" cannot mix legacy patterns and absolute paths');
    expect(found[1]).toContain('trust: "." cannot mix legacy patterns and absolute paths');
  });
});

describe('absolute trust containment', () => {
  test('a folder above the project root is refused when the root is known', () => {
    const found = errors(`${minimal}trust:\n  - /zz-root\n`, { root: '/zz-root/acme' });
    expect(found.join('\n')).toMatch(/trust: "\/zz-root" is a parent of the project: trust a folder of the team's own/);
  });

  test('the project root itself and a folder under it are accepted', () => {
    expect(errors(`${minimal}trust:\n  - /zz-root/acme\n  - /zz-root/acme/sub\n`, { root: '/zz-root/acme' })).toEqual([]);
  });

  test('without the root the parent check is skipped: the text alone cannot see it', () => {
    expect(errors(`${minimal}trust:\n  - /zz-root\n`)).toEqual([]);
  });

  test('a "~" entry is expanded against the given home, not the process\'s', () => {
    const text = `${minimal}trust:\n  - "~/package.json"\n`;
    const repo = fileURLToPath(new URL('..', import.meta.url));
    // Under the repo root, ~/package.json is a file: not a directory.
    expect(errors(text, { home: repo })).toEqual(['16: trust: "~/package.json" is not a directory']);
    // Under test/, the same entry names nothing that exists: accepted.
    expect(errors(text, { home: join(repo, 'test') })).toEqual([]);
  });
});

describe('workspace.branch', () => {
  const branch = (value: string) =>
    errors(change(minimal, '  mode: shared\n', `  mode: shared\n  branch: "${value}"\n`));

  test('a backtick is refused', () => {
    expect(branch('feat/`x`')).toEqual(['7: workspace.branch must not contain control characters or backticks']);
  });

  test('a control character is refused', () => {
    expect(branch(`feat/${String.fromCharCode(7)}`)).toEqual(['7: workspace.branch must not contain control characters or backticks']);
  });

  test('an ordinary branch passes', () => {
    expect(valid(change(minimal, '  mode: shared\n', '  mode: shared\n  branch: "{kind}/{task}"\n')).team.workspace.branch)
      .toBe('{kind}/{task}');
  });
});

describe('names and labels after count is expanded', () => {
  const second = `  - role: implementer
    name: lead-2
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;
  const counted = `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
    count: 2
`;
  test('two seats with one name', () => {
    expect(errors(minimal + change(second, 'lead-2', 'lead')).join('\n')).toMatch(/two seats have the name "lead"/);
  });
  test('an expanded name that meets an explicit one', () => {
    const text = minimal + counted + change(second, 'lead-2', 'worker-2');
    expect(errors(text).join('\n')).toMatch(/two seats have the name "worker-2" .*after count is expanded/);
  });
  test('two seats with one label', () => {
    const named = minimal.replace('    launch:', '    label: lead\n    launch:');
    const team = valid(`${named + second}    label: lead\n`).team;
    expect(team.seats.map((item) => item.name)).toEqual(['lead', 'lead-2']);
    expect(team.seats.every((item) => item.label === 'lead')).toBe(true);
  });
  test('distinct seats pass, and every instance counts for the default ceiling', () => {
    expect(valid(minimal + counted + second).team.limits.seats).toBe(6);
  });
});

describe('the worktree path', () => {
  const worktrees = (path: string, trust: string) =>
    change(minimal, 'mode: shared', `mode: worktree\n  base: main\n  path: ${path}`) + `trust:\n  - .\n  - ${trust}\n`;
  test('a fixed folder of its own, inside a trust pattern, passes', () => {
    expect(valid(worktrees('../worktrees/{repo}/{task}', '../worktrees/acme/*')).team.workspace.path).toBe('../worktrees/{repo}/{task}');
  });
  test('straight into the project\'s parent is refused', () => {
    expect(errors(worktrees('../{task}', '../worktrees/acme/*')).join('\n')).toMatch(/needs a fixed folder of its own before \{task\}/);
  });
  test('outside every trust pattern is refused', () => {
    expect(errors(worktrees('../elsewhere/{task}', '../worktrees/acme/*')).join('\n')).toMatch(/workspace.path matches no trust pattern/);
  });
  test('{task} must be the last segment', () => {
    expect(errors(worktrees('../wt/{task}/src', '../wt/*')).join('\n')).toMatch(/must end with the segment \{task\}/);
  });
});

describe('secrets', () => {
  test('a long random-looking value only warns, and names its line', () => {
    const text = `${minimal}tools:\n  chat: { kind: slack, channel: Zx8Kq2Lm9Pv4Rt7Wy1Bn6Cd3Fg5Hj0QsAeUiOpXc }\n`;
    const result = valid(text);
    expect(result.warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
  });
  test('ordinary ids and slugs don\'t warn', () => {
    const text = `${minimal}tools:\n  chat: { kind: slack, workspace: acme, channel: C04ABCDEF12 }\n`;
    expect(valid(text).warnings).toEqual([notice]);
  });
  test('a path that is a real directory never warns; everything shapeless of it, and a blob in path clothing, still does', () => {
    // The runner's TMPDIR shape, for real: long, dotless, absolute, on disk. The value CI warned
    // about at the trust line was this shape as a project root — and only a directory the reader
    // can see exempts the shape now. Build one; the shape alone silences nothing.
    const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'team-secrets-')));
    const shaped = join(base, `team-init-${randomBytes(24).toString('base64url')}`);
    mkdirSync(shaped);
    const inTrustLine = `${minimal}trust:\n  - ${shaped}\n`;
    try {
      expect(shaped).toMatch(/^\/[A-Za-z0-9/_-]+$/);
      expect(shaped.length).toBeGreaterThanOrEqual(32);
      expect(valid(inTrustLine).warnings).toEqual([notice]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    // Pairwise: the same file, the same word, the directory gone — it warns. So the quiet above
    // was the lstat's verdict, not a word the scanner never found random-looking.
    expect(valid(inTrustLine).warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
    // The field's own runner literal, on this machine: nothing behind it, so nothing exempts it —
    // absence fails closed and the value warns.
    const runner = '/private/var/folders/17/j2x0ly_d5_34bg_9vsy5f2140000gn/T/team-init-idhWGb/acme';
    expect(valid(`${minimal}trust:\n  - ${runner}\n`).warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
    // The boundary stays loud: a "/"-led blob with no second separator is not a path shape.
    const blobAfterSlash = `${minimal}tools:\n  chat: { kind: slack, channel: /Zx8Kq2Lm9Pv4Rt7Wy1Bn6Cd3Fg5Hj0QsAeUiOpXc }\n`;
    expect(valid(blobAfterSlash).warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
    // One segment after the slash is not a path shape either.
    const singleSegment = `${minimal}tools:\n  chat: { kind: slack, channel: /abcdefghijklmnopqrstuvwxyz0123456789abcd }\n`;
    expect(valid(singleSegment).warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
    // A path-shaped prefix over a credential-shaped word is not a directory either: what once
    // silenced it silences nothing now, and the value warns like any other.
    const inPathClothing = `${minimal}trust:\n  - /x/sk-Zx8Kq2Lm9Pv4Rt7Wy1Bn6Cd3Fg5Hj0QsAeUiOpXc\n`;
    expect(valid(inPathClothing).warnings).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
  });
  test('a regular file, and a symlink to a directory, are not directories to the exemption', () => {
    // lstat, never stat: a regular file is not a directory, and a symlink is lstat's own kind —
    // following it would widen the exemption to wherever it points. Pinned where a value lives;
    // in the trust slot both are refused by the section's own, older rules (a file is not a
    // directory, a symlink is refused as one), whatever the scanner would have said.
    const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'team-secrets-')));
    const file = join(base, `team-init-${randomBytes(24).toString('base64url')}`);
    const real = join(base, `dir-${randomBytes(24).toString('base64url')}`);
    const link = join(base, `link-${randomBytes(24).toString('base64url')}`);
    mkdirSync(real);
    writeFileSync(file, 'a value lives here\n');
    symlinkSync(real, link);
    try {
      const inChannel = (value: string) => valid(`${minimal}tools:\n  chat: { kind: slack, channel: ${value} }\n`).warnings;
      expect(inChannel(file)).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
      expect(inChannel(link)).toEqual([notice, { line: 16, message: expect.stringMatching(/random-looking/) }]);
      // The real directory is what quiets the word, in the same run.
      expect(inChannel(real)).toEqual([notice]);
      // The trust slot refuses both by its own rules, before the exemption matters.
      expect(errors(`${minimal}trust:\n  - ${file}\n`)).toEqual([expect.stringMatching(/is not a directory/)]);
      expect(errors(`${minimal}trust:\n  - ${link}\n`)).toEqual([expect.stringMatching(/is a symbolic link/)]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('every problem is reported at once, in line order', () => {
  const text = change(change(minimal, 'format: 1', 'format: 3'), '"5.5"', '5.5') + 'colour: blue\n';
  const found = errors(text);
  expect(found.length).toBe(3);
  expect(found.map((line) => Number(line.split(':')[0]))).toEqual([1, 13, 15]);
});
