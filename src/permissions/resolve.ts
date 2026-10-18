// The resolver: what one caller may do, decided from records — never from a name, never from
// what stands in a pane. The rules are the decision record's (decided-grants-minimum-2026-10-17
// §(c), §(f), and the tests at its foot):
//
//   - deny by default, absent is deny: a capability is not there until a record puts it there;
//   - most specific wins among the admitting rules, and the admitting rule is recorded — a
//     seat-level grant over the role's resolved bundle, both read under the team envelope;
//   - deny beats allow: a revoked or expired record is not among the active set the fresh read
//     returns (grants.ts's activeGrants), so it can never admit;
//   - a caller with no registry record is refused, and the refusal names the rule;
//   - every refusal names its rule.
//
// A seat's effective authority is its own list intersected with the team envelope: the
// capabilities its role's resolved bundle names plus its own seat-level grants, and nothing
// outside the envelope — never a union, so a team grant (an envelope, not a source) gives no
// seat a capability its role does not hold, and a seat grant can only narrow, never widen, the
// envelope. A seat resolves within the envelope of the team it belongs to, and never another
// team's, and every grant is read within its scope: a capability row whose target lies outside
// a seat grant's scope, or outside the envelope's, is refused under `outside-scope`. Nothing
// here resolves by a role's name, in any language: the name is recorded in the answers, and the
// bundle's capability words decide.
//
// The records are grants.ts's: `grants` is the active set — the fresh read every gate makes —
// and its `covers` decides whose grant a record is (a seat grant by the agent id, a team grant
// by the team id, by the id alone). The command side is map.ts's table, and a command the table
// does not name is refused here rather than judged. `send` and `answer` are the table's rows
// whose gates live elsewhere — the send admission and the pane-authority gate — and this
// resolver admits no one to either; their wiring asks its own gate. This module decides only:
// it reads no file, runs nothing, and the same inputs always give the same answer.
import { sep } from 'node:path';
import { activeGrants, covers, type GrantRecord } from './grants.ts';
import { COMMAND_GATES, isCapability, type Capability, type Gate } from './map.ts';

/** Who asks, as a record — not src/caller.ts's walked caller, which says where the ask came
 *  from: the owner, or a seat with its registry identity. */
export type CallerRecord =
  | { kind: 'owner' }
  | {
      kind: 'seat';
      /** The agent id the registry minted for the seat: what a seat grant names. */
      agent: string;
      /** The seat's name in the team file: named in the answers, never how they resolve. */
      seat: string;
      /** The team id the seat belongs to: whose envelope bounds it. */
      team: string;
      /** The role's name, for the answers alone. */
      role: string;
      /** The capabilities the role's resolved bundle names (§4): capability words, never a
       *  role's name and never one of the four administrative names. */
      bundle: readonly Capability[];
      /** The role holds `leads`. */
      leads?: boolean;
    };

/** The rule a decision stands on, recorded with it: the admitting rule of an allow, or what
 *  refused. */
export type PermissionRule =
  // allow
  | 'owner'
  | 'leads'
  | 'own-team'
  | 'record'
  | 'seat-grant'
  | 'role-bundle'
  // deny
  | 'no-record'
  | 'unreadable'
  | 'unplaced'
  | 'not-in-map'
  | 'owner-only'
  | 'owner-or-leads'
  | 'owner-or-own-team'
  | 'absent'
  | 'outside-envelope'
  | 'outside-scope'
  | 'other-team'
  | 'admission'
  | 'pane-authority';

/** Where the command would act: the team's root, and the path within it where the command names
 *  one. A capability row reads it against every grant's `scope` — a grant is used within its
 *  scope, and the target, never a grant's own word, decides whether it applies. */
export type PermissionTarget = { root: string; path?: string };

/** The answer: the effect, the rule it stands on, and the words a report or refusal says.
 *  Every deny's `why` names its rule. */
export type PermissionDecision = {
  effect: 'allow' | 'deny';
  rule: PermissionRule;
  why: string;
};

/**
 * Whether `caller` may run `command` toward `team`, decided from the active grant records:
 * gated rows by the map's gate, capability rows by the own-list ∩ envelope intersection.
 * `grants` is the active set — `activeGrants(home, now)`, read fresh at every gate, with the
 * revoked and expired left out; `covers` decides which records are the caller's, and `at` is
 * the target a capability row reads every scope against.
 */
export function resolvePermission(
  caller: CallerRecord | null,
  team: { id: string },
  command: string,
  grants: readonly GrantRecord[],
  at: PermissionTarget,
): PermissionDecision {
  const gate = COMMAND_GATES[command];
  if (gate === undefined) {
    return {
      effect: 'deny',
      rule: 'not-in-map',
      why: `the map names no \`${command}\` row: 0.5.0 gates no command the Kernel's table does not name`,
    };
  }
  if (caller === null) {
    return {
      effect: 'deny',
      rule: 'no-record',
      why: `no registry record stands for this caller — ${says(gate, command)}, and a caller with no record is refused`,
    };
  }
  if (caller.kind === 'owner') {
    // The two rows whose gates live elsewhere: the owner's word matters there, but it is those
    // gates' to weigh, not this map's.
    if (gate.kind === 'admission' || gate.kind === 'pane-authority') {
      return { effect: 'deny', rule: gate.kind, why: gate.why };
    }
    return { effect: 'allow', rule: 'owner', why: `the owner: ${gate.why}` };
  }

  switch (gate.kind) {
    case 'owner-only':
      return {
        effect: 'deny',
        rule: 'owner-only',
        why: `\`${command}\` is not ${caller.seat}'s: ${gate.why}`,
      };
    case 'owner-or-leads':
      if (caller.leads === true && caller.team === team.id) {
        return { effect: 'allow', rule: 'leads', why: `${caller.seat} leads its own team: ${gate.why}` };
      }
      return {
        effect: 'deny',
        rule: 'owner-or-leads',
        why: `\`${command}\` admits the owner or \`leads\` for its own team: ${caller.seat} ${
          caller.leads === true ? `leads a team, and not ${team.id}'s` : 'holds no `leads`'
        }`,
      };
    case 'owner-or-own-team':
      if (caller.team === team.id) {
        return { effect: 'allow', rule: 'own-team', why: `${caller.seat} belongs to its own team: ${gate.why}` };
      }
      return {
        effect: 'deny',
        rule: 'owner-or-own-team',
        why: `\`${command}\` admits the owner or the seat's own team: ${caller.seat} belongs to ${caller.team}, not ${team.id}`,
      };
    case 'seat-record':
      // The row admits a registry record, and the file's own declaration is not one: the
      // fallback record the bridge builds for an unregistered team carries no agent id, so no
      // read surface admits it (the file fallback judges the file's `leads` rows and comms
      // admission alone).
      if (caller.agent === '') {
        return {
          effect: 'deny',
          rule: 'no-record',
          why: `\`${command}\` admits any seat a registry record stands for: ${caller.seat} has none — the file's own declaration is not a registry record`,
        };
      }
      return { effect: 'allow', rule: 'record', why: `${caller.seat}'s registry record stands: ${gate.why}` };
    case 'admission':
    case 'pane-authority':
      return { effect: 'deny', rule: gate.kind, why: gate.why };
    case 'capability':
      return resolveCapability(caller, team, command, grants, at);
  }
}

/** The fresh read every gate makes, resolved: `activeGrants(home, now)` — revoked and expired
 *  records already left out — and the same decision the pure resolver would reach from them. */
export function resolveFromHome(
  home: string,
  caller: CallerRecord | null,
  team: { id: string },
  command: string,
  now: Date,
  at: PermissionTarget,
): PermissionDecision {
  return resolvePermission(caller, team, command, activeGrants(home, now), at);
}

/**
 * One capability row: the seat's own list — its role's resolved bundle plus its own seat-level
 * grants — intersected with the team envelope, and the whole read against the target: a grant
 * is used within its scope, so a seat grant that names the capability but not the target's
 * path refuses under `outside-scope`, and so does a team envelope whose scope does not hold
 * it. The seat must belong to the team asked about; a seat grant admits under `seat-grant`
 * (the most specific admitting rule, recorded over the bundle when both stand), the bundle
 * under `role-bundle`, and the envelope admits nothing by itself. Not named at all is
 * `absent`; named but outside the envelope is `outside-envelope`.
 */
function resolveCapability(
  caller: Extract<CallerRecord, { kind: 'seat' }>,
  team: { id: string },
  command: string,
  grants: readonly GrantRecord[],
  at: PermissionTarget,
): PermissionDecision {
  const capability = isCapability(command) ? command : null;
  if (capability === null) {
    // The map's capability rows come from the same vocabulary, so this cannot stand; refused
    // rather than judged all the same.
    return { effect: 'deny', rule: 'not-in-map', why: `the map names no \`${command}\` row` };
  }
  if (caller.team !== team.id) {
    return {
      effect: 'deny',
      rule: 'other-team',
      why: `\`${capability}\` resolves within a seat's own team's envelope: ${caller.seat} belongs to ${caller.team}, not ${team.id}`,
    };
  }
  const where = at.path ?? at.root;
  const namedGrants = grants.filter(
    (grant) => grant.kind === 'seat' && covers(grant, { agentId: caller.agent }) && grant.capabilities.includes(capability),
  );
  const named = namedGrants.map((grant) => grant.name).sort();
  const namedByGrant = named.map((name) => `\`${name}\``).join(', ');
  const held = caller.bundle.includes(capability);
  const envelopes = grants.filter(
    (grant) => grant.kind === 'team' && covers(grant, { teamId: team.id }) && grant.capabilities.includes(capability),
  );
  const enveloped = envelopes.length > 0;
  if (named.length > 0 || held) {
    if (!enveloped) {
      return {
        effect: 'deny',
        rule: 'outside-envelope',
        why: `\`${capability}\` is named for ${caller.seat}${
          named.length > 0 ? ` by seat grant ${namedByGrant}` : ` by \`${caller.role}\`'s resolved bundle`
        }, but team ${team.id}'s envelope does not carry it: effective authority is the own list intersected with the envelope, never a union`,
      };
    }
    if (named.length > 0 && !namedGrants.some((grant) => within(grant.scope, where))) {
      return {
        effect: 'deny',
        rule: 'outside-scope',
        why: `\`${capability}\` is named for ${caller.seat} by seat grant ${namedByGrant}, and not within its scope: ${where} is outside ${scopesOf(namedGrants)} — a grant is used within its scope`,
      };
    }
    if (!envelopes.some((grant) => within(grant.scope, where))) {
      return {
        effect: 'deny',
        rule: 'outside-scope',
        why: `\`${capability}\` is named for ${caller.seat}${
          named.length > 0 ? ` by seat grant ${namedByGrant}` : ` by \`${caller.role}\`'s resolved bundle`
        }, and team ${team.id}'s envelope ${scopesOf(envelopes)} does not hold ${where}: a grant is used within its scope`,
      };
    }
    return named.length > 0
      ? {
          effect: 'allow',
          rule: 'seat-grant',
          why: `seat grant ${namedByGrant} names \`${capability}\` for ${caller.seat} within its scope, and team ${team.id}'s envelope carries it`,
        }
      : {
          effect: 'allow',
          rule: 'role-bundle',
          why: `\`${caller.role}\`'s resolved bundle names \`${capability}\` for ${caller.seat}, and team ${team.id}'s envelope carries it within its scope`,
        };
  }
  if (enveloped) {
    return {
      effect: 'deny',
      rule: 'absent',
      why: `team ${team.id}'s envelope carries \`${capability}\`, but neither \`${caller.role}\`'s resolved bundle nor a live seat grant names it for ${caller.seat}: a team grant gives no seat a capability its role does not hold`,
    };
  }
  return {
    effect: 'deny',
    rule: 'absent',
    why: `nothing names \`${capability}\` for ${caller.seat} — \`${caller.role}\`'s resolved bundle does not, no live seat grant does, and team ${team.id}'s envelope does not carry it — and absent is deny`,
  };
}

/** Whether a path is inside one of a record's scope paths, the same containment a grant's
 *  write checks: the path itself, or below it. An empty scope holds nothing, so the read
 *  fails closed. */
function within(scope: readonly string[], path: string): boolean {
  return scope.some((parent) => {
    const root = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
    return path === root || path.startsWith(`${root}${sep}`);
  });
}

/** The scope paths of the records named, for a refusal's words. */
function scopesOf(grants: readonly GrantRecord[]): string {
  const paths = [...new Set(grants.flatMap((grant) => grant.scope))].sort();
  return paths.length > 0 ? paths.join(', ') : 'an empty scope';
}

/** What a gate asks for, said for a caller with no record: the refusal must name the rule. */
function says(gate: Gate, command: string): string {
  switch (gate.kind) {
    case 'owner-only':
      return `\`${command}\` is the owner's act alone in 0.5.0`;
    case 'owner-or-leads':
      return `\`${command}\` admits the owner or \`leads\` for its own team`;
    case 'owner-or-own-team':
      return `\`${command}\` admits the owner or the seat's own team`;
    case 'seat-record':
      return `\`${command}\` admits any seat with a registry record`;
    case 'capability':
      return `\`${command}\` is admitted by the seat holding it, within its scope`;
    case 'admission':
      return `admission is chain position and the pair's setting, decided by the send admission`;
    case 'pane-authority':
      return `a pane key is the pane's lead's, a seat above's, or the owner's word`;
  }
}
