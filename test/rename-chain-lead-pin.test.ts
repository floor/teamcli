// `team rename <seat>` on a team whose lead comes from the chain and whose approval pinned it:
// the edited file is validated under the verified approval's pin (carried through the rename),
// a live chain that has drifted is refused rather than signed over, and the rename moves the
// roster's `leads` mark only when the approval and the live file agree. Every scene is
// synthetic: homes, checkouts and registries are the test's own.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runRename } from '../src/commands/rename.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { getTeam, teamIdOf } from '../src/registry/teams.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const PROV = '{ registered_by: owner, registered_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" }';
const owner: Caller = { kind: 'owner' };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; file: string; store: string; teamId: string };

function seatStanza(name: string): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
}

/** A team file that names no lead of its own: the chain's registered project word decides it. */
function teamYaml(): string {
  return `format: 1
project: acme
session: acme
operator: worker
workspace:
  mode: shared
seats:
${seatStanza('lead')}
${seatStanza('worker')}
`;
}

function projectRecord(leadSeat: string, root: string): string {
  return [
    'projects:',
    '  acme:',
    '    name: Acme',
    '    entity: floor',
    '    lead: null',
    `    teams: [${teamIdOf(root)}]`,
    `    lead_seat: ${leadSeat}`,
    `    provenance: ${PROV}`,
    '',
  ].join('\n');
}

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rename-chain-lead-pin-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, teamYaml());
  const teamId = teamIdOf(root);
  writeFileSync(projectsFile(home), projectRecord('lead', root));

  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('; '));
  const store = storePath(loaded.team.project, root, home);
  writeApproval(store, { approval: approvalOf(loaded.team, root, NOW), file: readFileSync(file, 'utf8') }, [], home);
  for (const seat of loaded.team.seats) {
    registerLaunch({ home, team: loaded.team, root, by: 'owner', owner: true }, seat, `pane-${seat.name}`);
  }
  // A launch re-writes the project's `lead` through an upsert that does not carry `teams`; the
  // registry's grouping of this team is the owner's, so the scene puts it back before the rename.
  writeFileSync(projectsFile(home), projectRecord('lead', root));
  return { base, home, root, file, store, teamId };
}

describe('team rename <seat> under a chain-led approval', () => {
  test('with the live chain in agreement, the pin and the roster mark move with the renamed lead seat', async () => {
    const at = makeWorld();
    expect(readApproval(at.store)?.approval.lead).toBe('lead');

    const io = testIo(at.root, owner);
    const code = await runRename(['lead', 'lead2'], io, { home: at.home, now: () => NOW });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(at.file, 'utf8')).toContain('name: lead2');
    expect(readFileSync(at.file, 'utf8')).not.toContain('name: lead\n');
    const standing = approvalStanding(at.root, at.home);
    expect(standing.kind).toBe('verified');
    expect(readApproval(at.store)?.approval.lead).toBe('lead2');

    // The roster marks the seat the approval now pins, and the old name is gone.
    const roster = getTeam(at.home, at.teamId)?.roster ?? [];
    expect(roster.find((line) => line.seat === 'lead')).toBeUndefined();
    expect(roster.find((line) => line.seat === 'lead2')?.leads).toBe(true);
    expect(roster.find((line) => line.seat === 'worker')?.leads).toBeUndefined();

    // The chain's own word is the owner's to move. Once it names the renamed seat, the signed
    // record has no difference left: the orchestrator digest moved with the approval's pin,
    // never with the live chain.
    writeFileSync(projectsFile(at.home), projectRecord('lead2', at.root));
    const loaded = loadTeamFile(at.root, { home: at.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.team.orchestrator).toBe('lead2');
    expect(approvalDifferences(loaded.team, at.root, at.home)).toEqual([]);
  });

  test('under chain drift the rename is refused: nothing is signed over and the roster mark stays put', async () => {
    const at = makeWorld();
    // The external chain now leads with `worker`, a seat the approval never pinned.
    writeFileSync(projectsFile(at.home), projectRecord('worker', at.root));

    const io = testIo(at.root, owner);
    expect(await runRename(['lead', 'lead2'], io, { home: at.home, now: () => NOW })).toBe(1);
    expect(io.err).toContain('the live chain leads with "worker", but the approval pinned "lead"');

    // The file was not edited and the approval was not re-signed.
    const text = readFileSync(at.file, 'utf8');
    expect(text).toContain('name: lead\n');
    expect(text).not.toContain('lead2');
    expect(approvalStanding(at.root, at.home).kind).toBe('verified');
    expect(readApproval(at.store)?.approval.lead).toBe('lead');

    // The roster still marks the approved lead: the drift was reported, never signed over.
    const roster = getTeam(at.home, at.teamId)?.roster ?? [];
    expect(roster.find((line) => line.seat === 'lead')?.leads).toBe(true);
    expect(roster.find((line) => line.seat === 'worker')?.leads).toBeUndefined();
    expect(roster.find((line) => line.seat === 'lead2')).toBeUndefined();
  });
});
