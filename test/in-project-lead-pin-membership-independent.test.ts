// Membership note: this is the adapted copy of `in-project-lead-pin-independent.test.ts`, kept
// beside that untouched original. At this integration base a team's project lives on the team
// record (`teams.yaml` `project_id`); `projects.yaml` `teams[]` is derived and never read for
// membership. The original's scenes register membership by writing `teams[]` into `projects.yaml`
// only, which is inert here, so the scenes that claim a registered team record it with
// `upsertTeam(home, teamIdOf(root), { …, projectId })` and quote the generated team id in YAML
// (an all-digit id otherwise parses as a number and the registry file is refused). The scenes are
// otherwise the original's, so the same six checks are exercised against this base.
//
// Independent security verification for declared `in_project` lead-chain fallback, `renameSeat`
// top-level `lead:` rewriting, and `approval.lead` pin forwarding:
// 1. Baseline: `in_project` resolves `lead_seat` when the project has no registered teams yet,
//    `renameSeat` rewrites top-level `lead:`, and `approvedProjectOf` forwards the verified pin.
// 2. Adversarial (`readLeadChain` in `src/lead-chain.ts:47-52`): `in_project` is evaluated BEFORE
//    `ofTeam(home, teamIdOf(root))` instead of as a fallback, overriding the team's registered
//    home project in `projects.yaml` and picking a foreign project the team is not in.
// 3. Adversarial (`runRename` in `src/commands/rename.ts:648,699` + `recordSeatRenameOf` and
//    `recordTeamRenameOf` in `src/approve/approval.ts:237-301`): renaming the pinned lead seat
//    while the external chain has drifted moves `leads: true` in `teams.yaml` to an unapproved
//    seat and signs an inconsistent `approval.json` (`approval.lead` updated to the new name while
//    `fingerprints.sections.orchestrator` keeps the old seat's digest); `recordTeamRenameOf` omits
//    `{ home, root, lead: record.approval.lead }` and fails to carry the approval of a chain-led team.
// 4. Adversarial (`runApprove` in `src/approve/command.ts:290,297-307`): `runApprove` forwards
//    `previous.approval.lead` from the unverified `readApproval` record instead of `standing`, so
//    swapping `approval.lead` in `approval.json` alongside adding `leads: true` to another seat in
//    `.agents/team.yaml` tricks `team approve --dry-run` into reporting "only its layout changed"
//    and hiding the `orchestrator` change.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalDifferences,
  approvalOf,
  recordSeatRenameOf,
  recordTeamRenameOf,
} from '../src/approve/approval.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { runRename } from '../src/commands/rename.ts';
import { renameSeat, renameTeamIdentity } from '../src/file/lines.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { rulesFilePathOf } from '../src/launch/rules-file.ts';
import { readLeadChain } from '../src/lead-chain.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const PROV = '{ registered_by: owner, registered_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" }';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type World = { base: string; home: string; root: string };
/** Membership at this int base lives on the team record (teams.yaml project_id); projects.yaml teams[] is derived. */
function member(home: string, root: string, projectId: string): void {
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, lobby: lobbyDir(home), roster: [], lifecycle: 'running', by: 'test', projectId });
}


function seatStanza(name: string, extra = ''): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;
}

function teamYaml(
  root: string,
  options: {
    project?: string;
    inProject?: string;
    session?: string;
    topLead?: string;
    markSeat?: string;
    seats?: string[];
  } = {},
): string {
  const names = options.seats ?? ['lead', 'worker'];
  const project = options.project ?? 'acme';
  const session = options.session ?? 'acme';
  const renderedSeats = names
    .map((name) => seatStanza(name, options.markSeat === name ? '    leads: true\n' : ''))
    .join('');
  return `format: 1
project: ${project}
${options.inProject !== undefined ? `in_project: ${options.inProject}\n` : ''}session: ${session}
${options.topLead !== undefined ? `lead: ${options.topLead}\n` : ''}operator: worker
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
${renderedSeats}`;
}

function makeWorld(options: Parameters<typeof teamYaml>[1] = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'in-project-lead-pin-ind-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(root, options));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { base, home, root };
}

function loadChecked(at: World): ReturnType<typeof loadTeamFile> & { ok: true } {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('; '));
  return loaded;
}

function approveCurrent(at: World): string {
  const loaded = loadChecked(at);
  const store = storePath(loaded.team.project, loaded.root, at.home);
  writeApproval(
    store,
    {
      approval: approvalOf(loaded.team, loaded.root, NOW),
      file: readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8'),
    },
    loaded.team.seats,
    at.home,
    NOW,
  );
  return store;
}

function makeOwnerIo(cwd: string, home: string): Io & { out: string; err: string } {
  const io = {
    cwd,
    env: { HOME: home, USER: 'testowner', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    isTTY: true,
    stdinIsTTY: true,
    out: '',
    err: '',
    stdout(msg: string) {
      io.out += msg;
    },
    stderr(msg: string) {
      io.err += msg;
    },
  };
  return io;
}

describe('declared in_project fallback, renameSeat lead rewrite, and pin forwarding independent security verification', () => {
  test('1. baseline: in_project resolves an unclaimed home project lead_seat, renameSeat rewrites top-level lead:, and approvedProjectOf forwards the verified pin', () => {
    const at = makeWorld({ inProject: 'Acme', seats: ['rex', 'worker'] });
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        '    teams: []',
        '    lead_seat: rex',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );

    expect(readLeadChain({ home: at.home, root: at.root, inProject: 'Acme' })).toEqual({
      ok: true,
      chain: { project: 'rex' },
    });

    const store = approveCurrent(at);
    rmSync(projectsFile(at.home));
    const standing = approvalStanding(at.root, at.home);
    expect(standing.kind).toBe('verified');
    expect(rulesFilePathOf(standing, 'worker', at.root, at.home)).not.toBeNull();

    // Top-level `lead:` rewrite via `renameSeat`
    const topAt = makeWorld({ topLead: 'lead' });
    const topStore = approveCurrent(topAt);
    const teamPath = join(topAt.root, '.agents', 'team.yaml');
    const renamed = renameSeat(readFileSync(teamPath, 'utf8'), 'lead', 'lead2');
    expect(renamed).toContain('lead: lead2\n');
    writeFileSync(teamPath, renamed);
    const liveTop = loadChecked(topAt);
    const topStanding = approvalStanding(topAt.root, topAt.home);
    expect(topStanding.kind).toBe('verified');
    recordSeatRenameOf(topStanding, liveTop.team, liveTop.root, [{ from: 'lead', to: 'lead2' }], topAt.home);
    expect(approvalStanding(topAt.root, topAt.home).kind).toBe('verified');
    expect(readApproval(topStore)?.approval.lead).toBe('lead2');
    expect(readApproval(store)?.approval.lead).toBe('rex');
  });

  test('2. adversarial: readLeadChain must not let in_project override ofTeam when the team is already registered in projects.yaml', () => {
    const at = makeWorld({ inProject: 'ForeignProj', seats: ['rex', 'worker'] });
    const otherRoot = join(at.base, 'other-team');
    mkdirSync(otherRoot, { recursive: true });

    // `at.root` IS registered in `projects.yaml` under `home-proj` (`lead_seat: rex`), while
    // `foreign-proj` (`name: ForeignProj`, `lead_seat: worker`) belongs to `otherRoot`.
    // `in_project: ForeignProj` must NOT override `ofTeam(home, teamIdOf(at.root))` (`rex`).
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  home-proj:',
        '    name: HomeProj',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(at.root)}"]`,
        '    lead_seat: rex',
        `    provenance: ${PROV}`,
        '  foreign-proj:',
        '    name: ForeignProj',
        '    entity: foreign-entity',
        '    lead: null',
        `    teams: ["${teamIdOf(otherRoot)}"]`,
        '    lead_seat: worker',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    member(at.home, at.root, 'home-proj'); member(at.home, otherRoot, 'foreign-proj');

    const chainWhenRegistered = readLeadChain({
      home: at.home,
      root: at.root,
      inProject: 'ForeignProj',
    });
    expect(chainWhenRegistered).toEqual({
      ok: true,
      chain: { project: 'rex' },
    });

    const loadedWhenRegistered = validateTeamFile(readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8'), {
      home: at.home,
      root: at.root,
    });
    expect(loadedWhenRegistered.ok).toBe(true);
    if (loadedWhenRegistered.ok) {
      expect(loadedWhenRegistered.team.orchestrator).toBe('rex');
    }
  });

  test('3. adversarial: readLeadChain must not pick a project via in_project when that project already lists another team and not this team', () => {
    const at = makeWorld({ inProject: 'ForeignProj', seats: ['rex', 'worker'] });
    const otherRoot = join(at.base, 'other-team');
    mkdirSync(otherRoot, { recursive: true });

    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  foreign-proj:',
        '    name: ForeignProj',
        '    entity: foreign-entity',
        '    lead: null',
        `    teams: ["${teamIdOf(otherRoot)}"]`,
        '    lead_seat: worker',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    member(at.home, otherRoot, 'foreign-proj');

    const chainForForeignTeamProject = readLeadChain({
      home: at.home,
      root: at.root,
      inProject: 'ForeignProj',
    });
    expect(chainForForeignTeamProject).toEqual({
      ok: true,
      chain: {},
    });
  });

  test('4. adversarial: recordSeatRenameOf under chain drift must not sign an approval whose orchestrator digest disagrees with its own renamed approval.lead pin', () => {
    const at = makeWorld({ seats: ['lead', 'worker'] });
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(at.root)}"]`,
        '    lead_seat: lead',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    member(at.home, at.root, 'acme');

    const store = approveCurrent(at);
    expect(readApproval(store)?.approval.lead).toBe('lead');

    // External chain drifts to `worker` (unapproved) while the seat `lead` is renamed to `lead2`
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(at.root)}"]`,
        '    lead_seat: worker',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );

    const path = join(at.root, '.agents', 'team.yaml');
    writeFileSync(path, renameSeat(readFileSync(path, 'utf8'), 'lead', 'lead2'));
    const liveDuringDrift = loadChecked(at);
    const standingBefore = approvalStanding(at.root, at.home);
    expect(standingBefore.kind).toBe('verified');

    recordSeatRenameOf(
      standingBefore,
      liveDuringDrift.team,
      at.root,
      [{ from: 'lead', to: 'lead2' }],
      at.home,
    );

    // `recordSeatRenameOf` updated `approval.lead` to `'lead2'` and signed `renamedRecordFile`
    // under `'lead2'`. When the project's `lead_seat` is updated to `'lead2'` to match the renamed
    // lead seat, the signed approval must have zero differences (its `orchestrator` section
    // fingerprint must match its own `approval.lead === 'lead2'`, not stay stuck on `'lead'`).
    expect(readApproval(store)?.approval.lead).toBe('lead2');
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(at.root)}"]`,
        '    lead_seat: lead2',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    const afterLeadSeatUpdate = loadChecked(at);
    expect(afterLeadSeatUpdate.team.orchestrator).toBe('lead2');
    expect(approvalDifferences(afterLeadSeatUpdate.team, at.root, at.home)).toEqual([]);
  });

  test('5. adversarial: recordTeamRenameOf must forward approval.lead so team rename --team preserves a chain-led approval', () => {
    const teamRenameWorld = makeWorld({ seats: ['lead', 'worker'] });
    writeFileSync(
      projectsFile(teamRenameWorld.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(teamRenameWorld.root)}"]`,
        '    lead_seat: lead',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    member(teamRenameWorld.home, teamRenameWorld.root, 'acme');
    approveCurrent(teamRenameWorld);
    const standingBeforeTeamRename = approvalStanding(teamRenameWorld.root, teamRenameWorld.home);
    expect(standingBeforeTeamRename.kind).toBe('verified');

    const teamFile = join(teamRenameWorld.root, '.agents', 'team.yaml');
    const renamedTeamText = renameTeamIdentity(readFileSync(teamFile, 'utf8'), {
      project: 'acme-renamed',
      session: 'acme-renamed',
      oldSession: 'acme',
    });
    writeFileSync(teamFile, renamedTeamText);
    const loadedRenamedTeam = loadChecked(teamRenameWorld);
    recordTeamRenameOf(
      standingBeforeTeamRename,
      loadedRenamedTeam.team,
      teamRenameWorld.root,
      { project: 'acme-renamed', session: 'acme-renamed', oldSession: 'acme' },
      teamRenameWorld.home,
    );
    expect(approvalStanding(teamRenameWorld.root, teamRenameWorld.home).kind).toBe('verified');
    expect(approvalDifferences(loadedRenamedTeam.team, teamRenameWorld.root, teamRenameWorld.home)).toEqual([]);
  });

  test('6. adversarial: runApprove must not trust an unverified approval.lead pin swapped on disk to hide a lead change as layout-only', async () => {
    const at = makeWorld({ seats: ['lead', 'worker'] });
    writeFileSync(
      projectsFile(at.home),
      [
        'projects:',
        '  acme:',
        '    name: Acme',
        '    entity: floor',
        '    lead: null',
        `    teams: ["${teamIdOf(at.root)}"]`,
        '    lead_seat: lead',
        `    provenance: ${PROV}`,
        '',
      ].join('\n'),
    );
    member(at.home, at.root, 'acme');

    const store = approveCurrent(at);
    expect(approvalStanding(at.root, at.home).kind).toBe('verified');

    // Attacker edits `.agents/team.yaml` to put `leads: true` on `worker` AND swaps `"lead": "lead"`
    // to `"lead": "worker"` inside `approval.json` without the owner's signing key.
    writeFileSync(join(at.root, '.agents', 'team.yaml'), teamYaml(at.root, { markSeat: 'worker', seats: ['lead', 'worker'] }));
    const approvalJsonPath = join(store, 'approval.json');
    const rawApproval = JSON.parse(readFileSync(approvalJsonPath, 'utf8')) as Record<string, unknown>;
    rawApproval.lead = 'worker';
    writeFileSync(approvalJsonPath, `${JSON.stringify(rawApproval, null, 2)}\n`);

    expect(approvalStanding(at.root, at.home).kind).toBe('refused');

    const io = makeOwnerIo(at.root, at.home);
    const sources: ApproveSources = {
      ask: async () => null,
      waiting: () => 'empty',
      now: () => NOW,
      home: at.home,
    };
    const code = await runApprove(['--show'], io, sources);
    expect(code).toBe(0);

    // `runApprove` must NOT trust the unverified `previous.approval.lead === "worker"` and claim
    // "the same record as the copy approved on ...; only its layout changed." — it must show the
    // `leads: true` diff and report that `orchestrator` changed.
    expect(io.out).not.toContain('only its layout changed');
    expect(io.out).toContain('+    leads: true');
    expect(io.out).toContain('`orchestrator` changed');
  });
});
