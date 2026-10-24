import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { writeTextSignedApproval } from './helpers/text-signed-approval.ts';

// The team files as they were at tag v0.1.2, copied into fixtures/legacy/v0.1.2 and never edited:
// the digests below are pinned to those copies, so nothing here reads a live team file and an edit
// to the repository's own file — adding a seat is a normal edit — cannot redden this test.
const read = (file: string) => readFileSync(join(import.meta.dir, 'fixtures/legacy/v0.1.2', file), 'utf8');

// Seat digests `approvalOf` wrote at tag v0.1.2 (89d8b2d). An omitted label resolved to the
// seat's name there, and to the model and version here. The section digests of these files are
// the same on both.
const V012 = {
  'team.yaml': {
    'claude-coordinator': 'de5581c5f281a4d3e622009c9867d8344a685a051c3a7c49ebaacf978eca0d1b',
    'claude-implementer': '6d04f16e4f0f134566aadfd8190683f69d27df327536f26fd59e099c2794efd1',
    'claude-reviewer': '7742475ac054d36ed892cbb547a16bfde5c92de576ec52fba0159b73e544911a',
    'deepseek-implementer': 'bf7dbb4134df55687152e26f33559c0b2da681c620311057cafd3684c4fdab6c',
    'glm-implementer': 'cd6ff276008336ab5f286d3220a9ff24f2ce17a05fa816529ce6f66c2d94fc4b',
    'grok-implementer': '5ad4f853cf02301e899e17be32a2448372b9ad6e9b637c59b76dc835a58c5ab2',
    'astra-implementer': '5b32a8675f01fcad44cf4a533012800ccc318a4e53c14ea29e0b36bc198caeaf',
    'gemini-implementer': '0f8689ca5183d46f1058bd543d3fec42f2ecc2edb0ae3c1b586c4c22bbec3620',
    'claude-operator': 'd40e0b34239faf76493211dabbfa6924e69dcca78fd67c9b13eed01ae07b246e',
  },
  'example.yaml': {
    'claude-coordinator-acme': '0392b805a5e9684f780818d2587a4736d70ae18ebaf2c2172a63745af26023d8',
    'codex-acme': '8814db0b3428bda820ceb5fe53e600c5c508d1001076070ec5ec27e4db3a787d',
    'deepseek-acme': '02fd0b8164a8eda7197dd7a810d247e2116b42e8b11eb676b710748856211f8c',
    'deepseek-acme-2': '0df8be68ae90a771c2db4d6b2ec5da65767e31abbb80a8621357e522d92ac879',
    'grok-acme': 'b534081b5aeb30e57c7fda3a1a1ae0389e924a2b68e9995f17c6fd0c74852c9b',
  },
  // v0.1.1 hashed the same name-title, and left `parked` and `stopped` out of the digest.
  'v0.1.1:team.yaml': {
    'claude-coordinator': 'a5cbd59ea101b537555a1daa3d25f465a51c30bee840a9a57ac44e198ecd549b',
    'claude-implementer': '67699b1dbb8368a84036f3eb828b2ec26ceedf9a637b96dadbf344a0b1b2cd49',
    'claude-reviewer': '91b5620988519df360972082d6e5a4487f53b670d49b26b86f97528fc5637559',
    'deepseek-implementer': 'fb15acada4abbeaddc566e1ec554ec4bde8cb7ce75cd269977af535508a7f013',
    'glm-implementer': '7027749b041caa95c314c315b74d610448869aa63678b4b791689ebdba71eced',
    'grok-implementer': 'acddc18b5b3ff920ee8c46280485ea69af8fc00f9dcff444d8d262f564b1bd0c',
    'astra-implementer': '3d38e9a1abe328df05e2dd8c58c0621920bd2a8cde103f80800393c3f785d878',
    'gemini-implementer': '52d6765ff70e80bb1a2aba89806e18c0c1597ff5baaa551f1958e403c0449575',
    'claude-operator': '05fd042a4ed49afccc6511eac7d89a285efa214b0800a2c9497fc645128b26b2',
  },
  'v0.1.1:example.yaml': {
    'claude-coordinator-acme': 'ed61e47ddccf9d75216fb82777d0d7389e2d6479288e873a535ec9fea6668d4a',
    'codex-acme': '5d525672dbc2b243fe75623ea3151f3eac867a74dfc46d118df033346aae644c',
    'deepseek-acme': '4d2a2a1cfe2c1b5638cd11c1fed57c56beb42ad59d355eb265c867e39afda963',
    'deepseek-acme-2': 'c7f7f236396e45b869f569d23f7af838bc069135d19b3b2b234685779fb39a41',
    'grok-acme': '8113cb068aa08d6a309f016be782ca11dd7aeedf543a8fda3bdc0a2145fcce00',
  },
  'examples-team.yaml': {
    'claude-keeper': '6231a2b2fe006bc7a5f12cea59f7a7e6262cab9d0fabf6a7dae9c158b35aa62c',
    'claude-signal': 'cde177c72e839a1d8493afc3cbb4288f651241964d7a47bae63f05de18844939',
    'codex-beacon': '0c1e1ae08fd04d9a6edfe7c67088f5c2cd872f0dbf2d3c1831f5713b2bfb1a7d',
    'cursor-beacon': '5ce5567c657488fc9871cb591762bdc497f83128bdb26901e68d114a9046aa69',
    'nimbus-beacon': '9cf2f266875f4930a8aeb3806f1b4f4ce50fd39c8c9c4aaf9dd8190b6f7aa204',
    'nimbus-beacon-2': 'd625dba0d7aa26d874f506c230fedb7d345becb57c0fcbded9bdd944c357e7e2',
    'nimbus-beacon-3': '55ae833a7773299345d6ad7bc927ca1ef02701a1711ba552b04c01dd1ab73512',
  },
} as const;

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'team-legacy-label-')));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function team(source: string) {
  const result = validateTeamFile(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function approveAsV012(text: string, seats: Record<string, string>, file: string = text) {
  const parsed = team(text);
  const approval = approvalOf(parsed, home);
  approval.fingerprints = { ...approval.fingerprints, seats };
  // v0.1.2 signed the stored text; that record still verifies on the compatibility path.
  writeTextSignedApproval(storePath(parsed.project, home, home), { approval, file }, parsed.seats, home);
}

describe('an approval written by v0.1.2', () => {
  test('a file that omits label, approved then, still matches', () => {
    for (const file of ['team.yaml', 'example.yaml'] as const) {
      const text = read(file);
      approveAsV012(text, V012[file]);
      expect(approvalDifferences(team(text), home, home)).toEqual([]);
    }
  });

  test('editing a seat model after that approval is drift for that seat', () => {
    const one = read('team.yaml');
    approveAsV012(one, V012['team.yaml']);
    const edited = one.replace('model: GLM', 'model: GLM Next');
    expect(approvalDifferences(team(edited), home, home)).toEqual(['seat glm-implementer changed']);

    const two = read('example.yaml');
    approveAsV012(two, V012['example.yaml']);
    const next = two.replace('model: Grok', 'model: Grok Next');
    expect(approvalDifferences(team(next), home, home)).toEqual(['seat grok-acme changed']);
  });

  test('the same file approved by v0.1.1 still matches', () => {
    for (const file of ['team.yaml', 'example.yaml'] as const) {
      const text = read(file);
      approveAsV012(text, V012[`v0.1.1:${file}`]);
      expect(approvalDifferences(team(text), home, home)).toEqual([]);
    }
  });

  test('a file that already wrote its labels has no drift', () => {
    const text = read('examples-team.yaml');
    approveAsV012(text, V012['examples-team.yaml']);
    expect(approvalDifferences(team(text), home, home)).toEqual([]);
  });

  test('an unreadable stored copy adopts nothing', () => {
    const text = read('team.yaml');
    approveAsV012(text, V012['team.yaml'], 'not a team file\n');
    const differences = approvalDifferences(team(text), home, home);
    expect(differences).toEqual(Object.keys(V012['team.yaml']).map((name) => `seat ${name} changed`));
  });

  test('a digest already in the new shape is left alone', () => {
    const text = read('team.yaml');
    const parsed = team(text);
    writeApproval(storePath(parsed.project, home, home), { approval: approvalOf(parsed, home), file: text }, parsed.seats, home);
    expect(approvalDifferences(parsed, home, home)).toEqual([]);
    const edited = text.replace('model: GLM', 'model: GLM Next');
    expect(approvalDifferences(team(edited), home, home)).toEqual(['seat glm-implementer changed']);
  });

  // The point of the snapshots: the live file may gain a seat — that is a normal edit — and the
  // legacy approval reports that seat as new and no other seat as drift. The ceiling moves with
  // it: `limits.seats` defaults to the declared seats plus temporary, so a file that pins no
  // limits reports the ceiling as changed too. That is the reader's behaviour for any such file,
  // not something the snapshots change.
  test('a live file that gained a seat reports that one seat as new and nothing else', () => {
    const snapshot = read('team.yaml');
    approveAsV012(snapshot, V012['team.yaml']);
    const gained = snapshot + [
      '',
      '  - role: implementer',
      '    name: kimi-implementer',
      '    cli: claude-code',
      '    vendor: moonshot',
      '    model: Kimi K3',
      '    version: "3.1"',
      '    launch: claude',
      '',
    ].join('\n');
    expect(approvalDifferences(team(gained), home, home)).toEqual([
      '`limits` changed',
      'seat kimi-implementer is not in the last approval',
    ]);
  });

  // The suite no longer depends on the live files: not one of their paths may appear in this
  // file's source. Built from parts so the assertion cannot match its own text.
  test('this file reads no live team file', () => {
    const source = readFileSync(import.meta.path, 'utf8');
    for (const path of [['.github', '/', 'team.yaml'].join(''), ['examples', '/', 'team.yaml'].join(''), ['fixtures', '/', 'example.yaml'].join('')]) {
      expect(source.includes(path)).toBe(false);
    }
  });
});
