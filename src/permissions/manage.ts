// The command side of the standing grants: the forms `team grant <seat|@team> --capabilities …`
// and `team revoke <name>` that write the owner-signed records in the grants folder. The gate is
// the team-file editors' own — walkCaller plus isOwner, the same refusal sentence — because these
// write the same kind of owner-only authority the file forms do, and no mode waives it. The file
// forms stay where they were: this module is reached only for a `--capabilities` grant, and for a
// revoke whose bare name is a standing grant's.
//
// What each form resolves before anything is written:
//   - the team file of io.cwd must load: a standing grant names this project's root, and a
//     `@team` grant this project's team id;
//   - a seat names a *registered* agent (`findAgent`), and the record carries that agent's id,
//     never the seat name — the id is what `covers` matches;
//   - `@team` names the registered team of this root;
//   - the name is the seat's or team's default (`seat-<id>`, `team-<id>`) or `--name`, minus the
//     spellings the file forms read (`grant`, `delegate`, `revoke-…`), so a standing record and a
//     team-file edit can never share a word.
// Nothing here signs or writes files itself: `planGrant`/`writeGrant` and
// `planRevocation`/`writeRevocation` own that, and a dry run refuses exactly what a write refuses.

import { homedir } from 'node:os';
import type { AuthorityEditOptions, AuthorityEditResult } from '../authority-edit.ts';
import { describeCaller, isOwner, walkCaller } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { grantsDir } from '../grant.ts';
import { cleanedIo, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { writeJson, writeJsonError } from '../output/index.ts';
import { findAgent } from '../registry/agents.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import {
  planGrant,
  planRevocation,
  readGrants,
  RECORD_NAME_PATTERN,
  standingRevocationName,
  writeGrant,
  writeRevocation,
  type GrantRecord,
  type GrantRequest,
  type RevocationRequest,
} from './grants.ts';

/** A `team grant <seat|@team> --capabilities …` invocation, as far as its flags. */
export type StandingGrantEdit = {
  /** The positional: a seat name of a registered agent, or `@team` for this project's team. */
  seat: string;
  /** The comma-separated capability list, split; the record's check owns its shape. */
  capabilities: string[];
  scope?: string[];
  expires?: string;
  name?: string;
};

/** A `team revoke <name>` invocation: the standing grant's name as typed. */
export type StandingRevokeEdit = { name: string };

/**
 * The standing grant with this name, if there is one. The command layer asks before treating a
 * bare `team revoke <word>` as a record: a word no grant holds stays the invocation error.
 */
export function standingGrantNamed(home: string, name: string): GrantRecord | null {
  return readGrants(home).grants.find((grant) => grant.name === name) ?? null;
}

/** Writes the standing grant `edit` describes, or explains what a write would do. */
export function runStandingGrant(rawIo: Io, edit: StandingGrantEdit, options: AuthorityEditOptions = {}): AuthorityEditResult {
  const io = cleanedIo(rawIo);
  const json = Boolean(options.json);
  const caller = walkCaller(io);
  if (!isOwner(caller)) {
    const msg = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
    // The owner's dev-mode admission for exactly this gate.
    const lift = devModeOwnerLiftAtCwd(rawIo, { command: 'grant', refusal: msg, home: options.home ?? homedir() });
    if (lift === null || !lift.lifted) {
      if (json) {
        writeJsonError(rawIo, 'grant.refused', plainText(msg), 'the owner runs `team grant` from a terminal outside herdr', 1, 'owner-only');
      } else {
        io.stderr(`team grant: ${msg}\n`);
      }
      return 'refused';
    }
    io.stderr(`${lift.warning}\n`);
  }

  const home = options.home ?? homedir();
  try {
    const loaded = readTeamConfig(io.cwd, { home });
    if (!loaded.ok) {
      const msg = loaded.errors[0]?.message ?? 'the team file cannot be read';
      if (json) {
        writeJsonError(rawIo, 'grant.invalid', plainText(msg), null);
      } else {
        io.stderr(`team grant: ${msg}\n`);
      }
      return 'invalid';
    }
    const resolved = resolveGrantee(home, loaded.root, edit);
    if (resolved.kind === 'problem') {
      if (json) {
        writeJsonError(rawIo, 'grant.invalid', plainText(resolved.why), null);
      } else {
        io.stderr(`team grant: ${resolved.why}\n`);
      }
      return 'invalid';
    }
    const plan = planGrant(home, resolved.request);
    if (!plan.ok) {
      if (json) {
        writeJsonError(rawIo, 'grant.invalid', plainText(plan.why), null);
      } else {
        io.stderr(`team grant: ${plan.why}\n`);
      }
      return 'invalid';
    }
    if (options.dryRun) {
      const record = plan.record;
      const who = resolved.seat === null ? `team ${record.grantee}` : `${resolved.seat} (${record.grantee})`;
      const expiry = record.expires === null ? 'no expiry' : `expires ${record.expires}`;
      const summary = `grant: would write the ${record.kind} grant ${record.name} for ${who}: capabilities ${record.capabilities.join(', ')}; scope ${record.scope.join(', ')}; ${expiry}`;
      if (json) {
        writeJson(rawIo, 'team.grant', {
          format: 1 as const,
          dry_run: true,
          status: 'dry-run',
          action_summary: summary,
          project: loaded.team.project,
          session: loaded.team.session,
          target: edit.seat,
          capabilities: record.capabilities,
          scope: record.scope,
          plan: [{ step: 'grant', detail: summary, prefix: '+' as const }],
        });
      } else {
        io.stdout(`${summary}\n`);
      }
      return 'ok';
    }
    const written = writeGrant(home, resolved.request);
    if (!written.ok) {
      if (json) {
        writeJsonError(rawIo, 'grant.invalid', plainText(written.why), null);
      } else {
        io.stderr(`team grant: ${written.why}\n`);
      }
      return 'invalid';
    }
    if (json) {
      writeJson(rawIo, 'team.grant', {
        format: 1 as const,
        dry_run: false,
        status: 'updated',
        action_summary: 'grant: updated',
        project: loaded.team.project,
        session: loaded.team.session,
        target: edit.seat,
        capabilities: plan.record.capabilities,
        scope: plan.record.scope,
      });
    } else {
      io.stdout('grant: updated\n');
    }
    return 'ok';
  } catch (error) {
    const msg = reasonOf(error);
    if (json) {
      writeJsonError(rawIo, 'grant.refused', plainText(msg), null);
    } else {
      io.stderr(`team grant: ${msg}\n`);
    }
    return 'refused';
  }
}

/** Writes the revocation of the standing grant `edit.name`, or explains what a write would do. */
export function runStandingRevoke(rawIo: Io, edit: StandingRevokeEdit, options: AuthorityEditOptions = {}): AuthorityEditResult {
  const io = cleanedIo(rawIo);
  const json = Boolean(options.json);
  const caller = walkCaller(io);
  if (!isOwner(caller)) {
    const msg = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
    // The owner's dev-mode admission for exactly this gate.
    const lift = devModeOwnerLiftAtCwd(rawIo, { command: 'revoke', refusal: msg, home: options.home ?? homedir() });
    if (lift === null || !lift.lifted) {
      if (json) {
        writeJsonError(rawIo, 'revoke.refused', plainText(msg), 'the owner runs `team revoke` from a terminal outside herdr', 1, 'owner-only');
      } else {
        io.stderr(`team revoke: ${msg}\n`);
      }
      return 'refused';
    }
    io.stderr(`${lift.warning}\n`);
  }

  const home = options.home ?? homedir();
  try {
    const loaded = readTeamConfig(io.cwd, { home });
    if (!loaded.ok) {
      const msg = loaded.errors[0]?.message ?? 'the team file cannot be read';
      if (json) {
        writeJsonError(rawIo, 'revoke.invalid', plainText(msg), null);
      } else {
        io.stderr(`team revoke: ${msg}\n`);
      }
      return 'invalid';
    }
    const { grants, revocations } = readGrants(home);
    const grant = grants.find((entry) => entry.name === edit.name);
    if (grant === undefined) {
      const msg = `there is no grant ${edit.name} in ${grantsDir(home)}`;
      if (json) {
        writeJsonError(rawIo, 'revoke.invalid', plainText(msg), null);
      } else {
        io.stderr(`team revoke: ${msg}\n`);
      }
      return 'invalid';
    }
    if (revocations.some((entry) => entry.grant === grant.name && entry.grantGeneration === grant.generation)) {
      if (json) {
        const dryRun = Boolean(options.dryRun);
        writeJson(rawIo, 'team.revoke', {
          format: 1 as const,
          dry_run: dryRun,
          status: 'unchanged',
          action_summary: 'revoke: unchanged',
          project: loaded.team.project,
          session: loaded.team.session,
          target: edit.name,
          ...(dryRun ? { plan: [{ step: 'revoke', detail: 'revoke: unchanged', prefix: 'skip' as const }] } : {}),
        });
      } else {
        io.stdout('revoke: unchanged\n');
      }
      return 'ok';
    }
    const request: RevocationRequest = {
      name: standingRevocationName(grant.name, grant.generation, grants, revocations),
      grant: grant.name,
      generation: grant.generation,
    };
    const plan = planRevocation(home, request);
    if (!plan.ok) {
      if (json) {
        writeJsonError(rawIo, 'revoke.invalid', plainText(plan.why), null);
      } else {
        io.stderr(`team revoke: ${plan.why}\n`);
      }
      return 'invalid';
    }
    if (options.dryRun) {
      const summary = `revoke: would revoke the grant ${grant.name} at generation ${grant.generation}, writing the record ${plan.record.name}; nothing written`;
      if (json) {
        writeJson(rawIo, 'team.revoke', {
          format: 1 as const,
          dry_run: true,
          status: 'dry-run',
          action_summary: summary,
          project: loaded.team.project,
          session: loaded.team.session,
          target: edit.name,
          plan: [{ step: 'revoke', detail: summary, prefix: '+' as const }],
        });
      } else {
        io.stdout(`${summary}\n`);
      }
      return 'ok';
    }
    const written = writeRevocation(home, request);
    if (!written.ok) {
      if (json) {
        writeJsonError(rawIo, 'revoke.invalid', plainText(written.why), null);
      } else {
        io.stderr(`team revoke: ${written.why}\n`);
      }
      return 'invalid';
    }
    if (json) {
      writeJson(rawIo, 'team.revoke', {
        format: 1 as const,
        dry_run: false,
        status: 'updated',
        action_summary: 'revoke: updated',
        project: loaded.team.project,
        session: loaded.team.session,
        target: edit.name,
      });
    } else {
      io.stdout('revoke: updated\n');
    }
    return 'ok';
  } catch (error) {
    const msg = reasonOf(error);
    if (json) {
      writeJsonError(rawIo, 'revoke.refused', plainText(msg), null);
    } else {
      io.stderr(`team revoke: ${msg}\n`);
    }
    return 'refused';
  }
}

// ---- resolution ---------------------------------------------------------------------------

type Resolution = { kind: 'resolved'; seat: string | null; request: GrantRequest } | { kind: 'problem'; why: string };

/** The grantee and the name the invocation resolves to, or the reason it names nothing. */
function resolveGrantee(home: string, root: string, edit: StandingGrantEdit): Resolution {
  const teamId = teamIdOf(root);
  let seat: string | null = null;
  let kind: 'seat' | 'team';
  let grantee: string;
  if (edit.seat === '@team') {
    kind = 'team';
    if (getTeam(home, teamId) === null) {
      return { kind: 'problem', why: `the registry holds no team ${teamId} for ${root}: register the team before granting to it` };
    }
    grantee = teamId;
  } else if (edit.seat.startsWith('@')) {
    return { kind: 'problem', why: `"${edit.seat}" is not a grantee: name a seat, or @team for this project's team` };
  } else {
    kind = 'seat';
    const agent = findAgent(home, { team: teamId, seat: edit.seat });
    if (agent === null) {
      return { kind: 'problem', why: `no agent named "${edit.seat}" is registered in team ${teamId}: a seat grant names the agent's id, and an unregistered seat names nothing` };
    }
    seat = edit.seat;
    grantee = agent.id;
  }
  const name = edit.name ?? (kind === 'seat' ? `seat-${grantee}` : `team-${grantee}`);
  const nameProblem = recordNameProblem(name);
  if (nameProblem !== null) return { kind: 'problem', why: nameProblem };
  const request: GrantRequest = { name, kind, grantee, capabilities: edit.capabilities, roots: [root] };
  if (edit.scope !== undefined) request.scope = edit.scope;
  if (edit.expires !== undefined) request.expires = edit.expires;
  return { kind: 'resolved', seat, request };
}

/** Names the rule when a record name collides with the file forms' spellings. A pattern failure
 *  is left to the record's own check, whose message names that rule; this answers the collisions
 *  the grammar cannot see: the two words `team revoke` reads as its file forms, and the stem a
 *  revocation of this record would need — `revoke-<name>` shares the folder. */
function recordNameProblem(name: string): string | null {
  if (!RECORD_NAME_PATTERN.test(name)) return null;
  if (name === 'grant' || name === 'delegate') {
    return `"${name}" is a team-file form: team revoke reads that word as grant or delegate, so a standing record cannot be named it`;
  }
  if (name.startsWith('revoke-')) {
    return `"${name}" is reserved: a revocation record is named revoke-<name> and shares the grants folder`;
  }
  if (!RECORD_NAME_PATTERN.test(`revoke-${name}`)) {
    return `"${name}" is too long for a revocation: revoke-<name> is one file name of at most 64 characters`;
  }
  return null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
