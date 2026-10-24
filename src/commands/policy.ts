import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownerSeatHelperPath, readOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { ownerDeviceConsent } from '../security/profile.ts';
import { readArgs } from '../args.ts';
import { describeCaller, fileOwnerRefusal, isOwner, walkCaller } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import { currentTeam } from '../file/current.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import {
  contextLine,
  hasJsonFlag,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
} from '../output/index.ts';
import {
  ADVISED_POLICY_NAMES,
  ENFORCED_POLICY_NAMES,
  loadAndResolvePolicyChain,
  logExpiredPoliciesOnce,
  normalizePolicyName,
  planPolicySet,
  planPolicyUnset,
  POLICY_CATALOGUE,
  POLICY_LEVELS,
  resolvePolicyChain,
  readPolicyChain,
  writePolicySet,
  writePolicyUnset,
  type EffectivePolicy,
  type PolicyKind,
  type PolicyLevel,
  type PolicyValue,
} from '../policy/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { findAgent, getAgent, isAgentId } from '../registry/agents.ts';
import { ofTeam as projectOfTeam, projectIdOf } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { seatNumberingOf } from '../settings/inherit.ts';

export const USAGE = `Usage: team policy [--seat <name>] [--file <path>] [--json]
       team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
       team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

Exits 0 when policies are listed, updated, or planned, 1 when refused, 2 when the invocation or team file is invalid.
`;

export type PolicyCommandOptions = {
  home?: string;
  now?: Date | (() => Date);
  /** Test seam: the owner-seat credential store used for --owner-device consent. */
  ownerSeatStore?: OwnerSeatKeyStore;
};

function resolveNow(now: Date | (() => Date) | undefined): Date {
  if (typeof now === 'function') return now();
  return now ?? new Date();
}

export const policy: Command = (argv, io) => runPolicy(argv, io);
export default policy;

type PolicyOutcome = 'ok' | 'refused' | 'invalid' | 'invocation';

export async function runPolicy(
  argv: string[],
  rawIo: Io,
  options: PolicyCommandOptions = {},
): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(
    argv,
    ['until', 'kind', 'entity', 'project', 'seat', 'file'],
    ['dry-run', 'json', 'owner-device'],
  );
  let outcome: PolicyOutcome;
  if (args.error !== undefined) {
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', plainText(args.error), null);
    } else {
      io.stderr(`team policy: ${plainText(args.error)}\n${USAGE}`);
    }
    outcome = 'invocation';
  } else {
    const sub = args.rest[0];
    if (sub === undefined) {
      outcome = executePolicyView(args.values, args.flags, rawIo, io, json, options);
    } else if (sub === 'set') {
      outcome = executePolicySet(args.rest.slice(1), args.values, args.flags, rawIo, io, json, options);
    } else if (sub === 'unset') {
      outcome = executePolicyUnset(args.rest.slice(1), args.values, args.flags, rawIo, io, json, options);
    } else {
      const why = `unexpected "${sub}"; expected "set", "unset", or no subcommand`;
      if (json) {
        writeJsonError(rawIo, 'policy.invocation', plainText(why), null);
      } else {
        io.stderr(`team policy: ${plainText(why)}\n${USAGE}`);
      }
      outcome = 'invocation';
    }
  }

  if (outcome === 'invocation') {
    return 2; // exit: policy.invocation
  }
  if (outcome === 'invalid') {
    return 2; // exit: policy.invalid
  }
  if (outcome === 'refused') {
    return 1; // exit: policy.refused
  }
  return 0; // exit: policy.done
}

function formatValueCell(value: PolicyValue, name?: string): string {
  if (name === 'seat-numbering') {
    const numbering = seatNumberingOf(value);
    if (numbering !== null) {
      return `width ${String(numbering.width)}, separator ${numbering.separator || 'none'}`;
    }
  }
  if (Array.isArray(value)) return value.join(', ');
  if (value === '') return '-';
  return String(value);
}

function isPolicySet(item: EffectivePolicy): boolean {
  if (item.kind === 'advised' && item.level === 'default') {
    if (item.value === '') return false;
    if (Array.isArray(item.value) && item.value.length === 0) return false;
  }
  return true;
}

function policyValuesMatch(a: PolicyValue, b: PolicyValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, idx) => entry === b[idx]);
  }
  return a === b;
}

function differsFromTeam(item: EffectivePolicy, teamPolicies: Record<string, EffectivePolicy> | null): boolean {
  if (!teamPolicies) return false;
  const teamItem = teamPolicies[item.name];
  if (!teamItem) return true;
  return !policyValuesMatch(item.value, teamItem.value);
}

function orderedEffectivePolicies(policies: Record<string, EffectivePolicy>): EffectivePolicy[] {
  const canonicalOrder: string[] = [...ENFORCED_POLICY_NAMES, ...ADVISED_POLICY_NAMES];
  const seen = new Set<string>();
  const out: EffectivePolicy[] = [];
  for (const name of canonicalOrder) {
    const entry = policies[name];
    if (entry) {
      out.push(entry);
      seen.add(name);
    }
  }
  for (const name of Object.keys(policies).sort()) {
    if (seen.has(name)) continue;
    const entry = policies[name];
    if (entry) out.push(entry);
  }
  return out;
}

export function resolveProjectIdForTeam(home: string, root: string, team: TeamFile): string | null {
  try {
    const fromRegistry = projectOfTeam(home, teamIdOf(root));
    if (fromRegistry?.id) return fromRegistry.id;
  } catch {
    // Fall back to team.inProject when registry is unreadable or ambiguous.
  }
  if (team.inProject) {
    try {
      return projectIdOf(team.inProject);
    } catch {
      return null;
    }
  }
  try {
    return projectIdOf(team.project);
  } catch {
    return null;
  }
}

function executePolicyView(
  values: Record<string, string | undefined>,
  flags: Set<string>,
  rawIo: Io,
  io: Io,
  json: boolean,
  options: PolicyCommandOptions,
): PolicyOutcome {
  if (
    values.until !== undefined ||
    values.kind !== undefined ||
    values.entity !== undefined ||
    values.project !== undefined ||
    flags.has('dry-run')
  ) {
    const why = '--until, --kind, --entity, --project, and --dry-run belong to `team policy set` or `team policy unset`';
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', why, null);
    } else {
      io.stderr(`team policy: ${why}\n${USAGE}`);
    }
    return 'invocation';
  }

  const home = options.home ?? homedir();
  const now = resolveNow(options.now);
  const walked = walkCaller(rawIo);
  const owner = isOwner(walked);

  if (values.file !== undefined) {
    const refusal = fileOwnerRefusal(rawIo, values.file);
    if (refusal !== undefined) {
      if (json) {
        writeJsonError(
          rawIo,
          'policy.refused',
          plainText(refusal),
          'the owner runs `team policy --file <path>` from a terminal outside herdr',
          1,
          'owner-only',
        );
      } else {
        io.stderr(`team policy: ${plainText(refusal)}\n`);
      }
      return 'refused';
    }
  }

  const current = currentTeam(rawIo.cwd, owner ? values.file : undefined, now, home, owner);
  if (!owner) {
    const allowed = current.ok && mayReadTeam(current, rawIo, { home });
    if (!current.ok || !allowed) {
      const msg = 'this team is not yours to read';
      if (json) {
        writeJsonError(rawIo, 'policy.refused', msg, null);
      } else {
        io.stderr(`team policy: ${msg}\n`);
      }
      return 'refused';
    }
  } else if (!current.ok) {
    const msg = current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${plainText(p.message)}`).join('; ');
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', msg, null);
    } else {
      for (const p of current.errors) {
        io.stderr(`team policy: ${p.line ? `team.yaml line ${p.line}: ` : ''}${plainText(p.message)}\n`);
      }
    }
    return 'invalid';
  }

  const { team, root } = current;
  let seat: Seat | null = null;
  let agentId: string | null = null;
  if (values.seat !== undefined) {
    seat = team.seats.find((s) => s.name === values.seat) ?? null;
    if (!seat) {
      const msg = `no seat "${values.seat}" is declared in ${team.project}`;
      if (json) {
        writeJsonError(rawIo, 'policy.invalid', plainText(msg), null);
      } else {
        io.stderr(`team policy: ${plainText(msg)}\n`);
      }
      return 'invalid';
    }
    const agent = findAgent(home, { team: teamIdOf(root), seat: seat.name });
    agentId = agent?.id ?? null;
  }

  const projectId = resolveProjectIdForTeam(home, root, team);
  const resolved = loadAndResolvePolicyChain(
    {
      home,
      entity: team.entity,
      projectId,
      teamRoot: root,
      team,
      agentId,
      seat,
    },
    {
      now,
      upToLevel: seat ? 'seat' : 'team',
    },
  );

  logExpiredPoliciesOnce(join(root, '.agents'), resolved.expired, now);

  if (!resolved.ok) {
    const msg = resolved.refusals.map((r) => r.message).join('; ');
    if (json) {
      writeJsonError(rawIo, 'policy.refused', plainText(msg), null);
    } else {
      for (const r of resolved.refusals) {
        io.stderr(`team policy: ${plainText(r.message)}\n`);
      }
    }
    return 'refused';
  }

  const items = orderedEffectivePolicies(resolved.policies);
  if (json) {
    writeJson(rawIo, 'team.policy', {
      format: 1 as const,
      status: 'ok' as const,
      project: team.project,
      session: team.session,
      entity: team.entity,
      in_project: team.inProject,
      seat: seat?.name ?? null,
      dev_mode_governed: resolved.devModeGoverned,
      policies: items.map((item) => ({
        name: item.name,
        value: Array.isArray(item.value) ? [...item.value] : item.value,
        level: item.level,
        setter: item.setter,
        date: item.date,
        expiry: item.expiry,
        kind: item.kind,
        set: isPolicySet(item),
      })),
    });
    return 'ok';
  }

  const teamResolved = seat
    ? loadAndResolvePolicyChain(
        {
          home,
          entity: team.entity,
          projectId,
          teamRoot: root,
          team,
          agentId: null,
          seat: null,
        },
        {
          now,
          upToLevel: 'team',
        },
      )
    : null;
  const teamPolicies = teamResolved && teamResolved.ok ? teamResolved.policies : null;
  const setItems = items.filter((item) => isPolicySet(item));
  const unsetItems = items.filter((item) => !isPolicySet(item));
  const hasSeatDiffs = seat !== null && items.some((item) => differsFromTeam(item, teamPolicies));

  const style = ttyStyle(rawIo);
  const headerLine = seat
    ? `${contextLine(team.project, team.session)} · seat ${seat.name}`
    : contextLine(team.project, team.session);
  const lines: string[] = [headerLine];
  if (seat !== null && !hasSeatDiffs) {
    lines.push('  same as the team');
  } else {
    lines.push(
      ...renderTable({
        headers: ['POLICY', 'VALUE', 'LEVEL', 'SETTER', 'EXPIRY', 'KIND'],
        rows: setItems.map((item) => {
          const teamItem = teamPolicies?.[item.name];
          const teamValueText =
            teamItem && isPolicySet(teamItem) ? formatValueCell(teamItem.value, teamItem.name) : 'not set';
          const kindCell =
            seat !== null && differsFromTeam(item, teamPolicies)
              ? `${item.kind} (differs from team: ${teamValueText})`
              : item.kind;
          return [
            item.name,
            formatValueCell(item.value, item.name),
            item.level,
            item.setter ?? '-',
            item.expiry ?? '-',
            kindCell,
          ];
        }),
        indent: '  ',
        style,
      }),
    );
  }
  if (unsetItems.length > 0) {
    lines.push(`  not set: ${unsetItems.map((item) => item.name).join(', ')}`);
  }
  const rendered = `${lines.join('\n')}\n`;
  if (style.enabled) {
    rawIo.stdout(rendered);
  } else {
    io.stdout(rendered);
  }
  return 'ok';
}

function parseLevelArg(rawLevel: string, seatFlag: string | undefined): { level: PolicyLevel; seatName?: string } | { error: string } {
  if (rawLevel.startsWith('seat:')) {
    const seatName = rawLevel.slice('seat:'.length).trim();
    if (!seatName) return { error: 'a seat name is required after "seat:"' };
    return { level: 'seat', seatName };
  }
  if (!(POLICY_LEVELS as readonly string[]).includes(rawLevel)) {
    return { error: `"${rawLevel}" is not a policy level: expected ${POLICY_LEVELS.join(', ')}` };
  }
  const level = rawLevel as PolicyLevel;
  if (level === 'seat') {
    if (!seatFlag || !seatFlag.trim()) {
      return { error: 'level "seat" requires --seat <name> (or "seat:<name>")' };
    }
    return { level: 'seat', seatName: seatFlag.trim() };
  }
  return { level };
}

type TargetContext = {
  target: string;
  teamRoot?: string;
  projectName?: string;
  projectEntity?: string | null;
  logDir?: string;
  projectLabel: string | null;
  sessionLabel: string | null;
  team?: TeamFile | null;
};

function resolveWriteTarget(
  home: string,
  level: PolicyLevel,
  seatName: string | undefined,
  policyName: string,
  values: Record<string, string | undefined>,
  cwd: string,
): { ok: true; ctx: TargetContext } | { ok: false; why: string } {
  const canonical = normalizePolicyName(policyName);
  const spec = POLICY_CATALOGUE[canonical as keyof typeof POLICY_CATALOGUE];
  if (spec && !spec.levels.includes(level)) {
    return {
      ok: false,
      why: `policy "${canonical}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})`,
    };
  }

  const loaded = readTeamConfig(cwd, { file: values.file, home });
  const team = loaded.ok ? loaded.team : null;
  const root = loaded.ok ? loaded.root : undefined;
  const logDir = root ? join(root, '.agents') : undefined;
  const projectLabel = team?.project ?? null;
  const sessionLabel = team?.session ?? null;

  if (level === 'entity') {
    const entity = values.entity?.trim() || team?.entity || null;
    if (!entity) {
      return {
        ok: false,
        why: 'no entity is declared in the team file; pass --entity <name> or set entity: in .agents/team.yaml',
      };
    }
    return {
      ok: true,
      ctx: {
        target: entity,
        teamRoot: root,
        logDir,
        projectLabel,
        sessionLabel,
        team,
      },
    };
  }

  if (level === 'project') {
    const rawProject = values.project?.trim() || team?.inProject || team?.project || null;
    if (!rawProject) {
      return {
        ok: false,
        why: 'no project is available; pass --project <id> or run inside a team checkout',
      };
    }
    let projectId: string;
    try {
      projectId =
        values.project === undefined && root
          ? (projectOfTeam(home, teamIdOf(root))?.id ?? projectIdOf(rawProject))
          : projectIdOf(rawProject);
    } catch (error) {
      return { ok: false, why: (error as Error).message };
    }
    return {
      ok: true,
      ctx: {
        target: projectId,
        teamRoot: root,
        projectName: rawProject,
        projectEntity: team?.entity ?? null,
        logDir,
        projectLabel,
        sessionLabel,
        team,
      },
    };
  }

  if (!loaded.ok || !root || !team) {
    const why = loaded.ok ? 'the team file cannot be read' : (loaded.errors[0]?.message ?? 'the team file cannot be read');
    return { ok: false, why };
  }

  if (level === 'team') {
    return {
      ok: true,
      ctx: {
        target: teamIdOf(root),
        teamRoot: root,
        logDir,
        projectLabel,
        sessionLabel,
        team,
      },
    };
  }

  // level === 'seat'
  if (!seatName) {
    return { ok: false, why: 'level "seat" requires --seat <name>' };
  }
  if (isAgentId(seatName)) {
    const agent = getAgent(home, seatName);
    if (!agent) {
      return { ok: false, why: `no agent "${seatName}" is registered` };
    }
    return {
      ok: true,
      ctx: {
        target: agent.id,
        teamRoot: root,
        logDir,
        projectLabel,
        sessionLabel,
        team,
      },
    };
  }
  const agent = findAgent(home, { team: teamIdOf(root), seat: seatName });
  if (!agent) {
    return {
      ok: false,
      why: `no agent named "${seatName}" is registered in team ${teamIdOf(root)}; register the seat before setting a seat policy`,
    };
  }
  return {
    ok: true,
    ctx: {
      target: agent.id,
      teamRoot: root,
      logDir,
      projectLabel,
      sessionLabel,
      team,
    },
  };
}

function executePolicySet(
  rest: string[],
  values: Record<string, string | undefined>,
  flags: Set<string>,
  rawIo: Io,
  io: Io,
  json: boolean,
  options: PolicyCommandOptions,
): PolicyOutcome {
  if (rest.length !== 3) {
    const why = 'usage: team policy set <level> <name> <value> [--until <iso>]';
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', why, null);
    } else {
      io.stderr(`team policy: ${why}\n${USAGE}`);
    }
    return 'invocation';
  }

  const caller = walkCaller(rawIo);
  if (!isOwner(caller)) {
    const msg = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
    // The owner's dev-mode admission for exactly this gate.
    const lift = devModeOwnerLiftAtCwd(rawIo, { command: 'policy', refusal: msg, home: options.home ?? homedir() });
    // Without the owner terminal, the owner's device: once an owner seat exists, one Touch ID from it.
    const consent = (lift === null || !lift.lifted) && (flags.has('owner-device') || readOwnerSeat(options.home ?? homedir()) !== null)
      ? ownerDeviceConsent(options.home ?? homedir(), options.ownerSeatStore ?? systemOwnerSeatKeyStore(ownerSeatHelperPath(options.home ?? homedir())), { act: 'policy set', args: rest }, `TeamCLI: policy set ${rest.join(' ')}`)
      : null;
    if ((lift === null || !lift.lifted) && consent?.ok !== true) {
      if (consent !== null && !consent.ok) io.stderr(`team policy: owner-device consent: ${plainText(consent.why)}\n`);
      if (json) {
        writeJsonError(
          rawIo,
          'policy.refused',
          plainText(msg),
          'the owner runs `team policy set` from a terminal outside herdr, or confirms it with Touch ID from the owner seat',
          1,
          'owner-only',
        );
      } else {
        io.stderr(`team policy: ${plainText(msg)}\n`);
      }
      return 'refused';
    }
    io.stderr(consent?.ok === true ? `team policy: confirmed on the owner's device by signer ${consent.signer}\n` : `${lift?.warning ?? ''}\n`);
  }

  const [rawLevel, rawName, rawValue] = rest as [string, string, string];
  const parsedLevel = parseLevelArg(rawLevel, values.seat);
  if ('error' in parsedLevel) {
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', parsedLevel.error, null);
    } else {
      io.stderr(`team policy: ${parsedLevel.error}\n${USAGE}`);
    }
    return 'invocation';
  }

  let kind: PolicyKind | undefined;
  if (values.kind !== undefined) {
    if (values.kind !== 'enforced' && values.kind !== 'advised') {
      const why = `--kind must be "enforced" or "advised", got "${values.kind}"`;
      if (json) {
        writeJsonError(rawIo, 'policy.invocation', why, null);
      } else {
        io.stderr(`team policy: ${why}\n${USAGE}`);
      }
      return 'invocation';
    }
    kind = values.kind;
  }

  const home = options.home ?? homedir();
  const now = resolveNow(options.now);
  const resolvedTarget = resolveWriteTarget(
    home,
    parsedLevel.level,
    parsedLevel.seatName,
    rawName,
    values,
    rawIo.cwd,
  );
  if (!resolvedTarget.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(resolvedTarget.why), null);
    } else {
      io.stderr(`team policy: ${plainText(resolvedTarget.why)}\n`);
    }
    return 'invalid';
  }

  const { ctx } = resolvedTarget;
  const request = {
    level: parsedLevel.level,
    target: ctx.target,
    teamRoot: ctx.teamRoot,
    projectName: ctx.projectName,
    projectEntity: ctx.projectEntity,
    name: rawName,
    value: rawValue,
    expiry: values.until ?? null,
    ...(kind !== undefined ? { kind } : {}),
  };

  const plan = planPolicySet(home, request, { now });
  if (!plan.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(plan.why), null);
    } else {
      io.stderr(`team policy: ${plainText(plan.why)}\n`);
    }
    return 'invalid';
  }

  // Check whether this declaration would loosen a higher level already set in the chain.
  if (ctx.teamRoot || ctx.team) {
    const chainSources = readPolicyChain({
      home,
      entity: parsedLevel.level === 'entity' ? ctx.target : (ctx.team?.entity ?? values.entity ?? null),
      projectId:
        parsedLevel.level === 'project'
          ? ctx.target
          : ctx.team && ctx.teamRoot
            ? resolveProjectIdForTeam(home, ctx.teamRoot, ctx.team)
            : null,
      teamRoot: ctx.teamRoot ?? null,
      team: ctx.team ?? null,
      agentId: parsedLevel.level === 'seat' ? ctx.target : null,
      seat:
        parsedLevel.level === 'seat' && parsedLevel.seatName
          ? (ctx.team?.seats.find((s) => s.name === parsedLevel.seatName) ?? null)
          : null,
    });
    const currentLevelSource = chainSources[parsedLevel.level];
    const currentPolicies = currentLevelSource?.ok ? currentLevelSource.policies.filter((p) => p.name !== plan.policy.name) : [];
    chainSources[parsedLevel.level] = {
      ok: true,
      level: parsedLevel.level,
      target: ctx.target,
      policies: [...currentPolicies, plan.policy],
    };
    const checkChain = resolvePolicyChain(chainSources, { now, upToLevel: parsedLevel.level });
    if (!checkChain.ok) {
      const refusal = checkChain.refusals[0]!;
      if (json) {
        writeJsonError(rawIo, 'policy.refused', plainText(refusal.message), null);
      } else {
        io.stderr(`team policy: ${plainText(refusal.message)}\n`);
      }
      return 'refused';
    }
  }

  const dryRun = flags.has('dry-run');
  const prevStr = plan.previous ? formatValueCell(plan.previous.value) : 'unset';
  const nextStr = formatValueCell(plan.policy.value);
  const untilSuffix = plan.policy.expiry ? ` until ${plan.policy.expiry}` : '';

  if (dryRun) {
    const summary = `policy: would set ${plan.policy.name}=${nextStr}${untilSuffix} at ${parsedLevel.level} (${ctx.target})`;
    if (json) {
      writeJson(rawIo, 'team.policy', {
        format: 1 as const,
        dry_run: true,
        status: 'dry-run',
        action_summary: summary,
        project: ctx.projectLabel,
        session: ctx.sessionLabel,
        level: parsedLevel.level,
        target: ctx.target,
        policy: plan.policy.name,
        value: Array.isArray(plan.policy.value) ? [...plan.policy.value] : plan.policy.value,
        expiry: plan.policy.expiry ?? null,
        kind: plan.policy.kind,
        plan: [{ step: 'policy', detail: summary, prefix: '+' as const }],
      });
    } else {
      io.stdout(`${summary}\n`);
    }
    return 'ok';
  }

  const written = writePolicySet(home, request, { now });
  if (!written.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(written.why), null);
    } else {
      io.stderr(`team policy: ${plainText(written.why)}\n`);
    }
    return 'invalid';
  }

  if (ctx.logDir) {
    logLine(
      ctx.logDir,
      'policy',
      'owner',
      `level ${parsedLevel.level} (${ctx.target}) ${written.policy.name}: ${prevStr} -> ${nextStr}${untilSuffix} (setter: owner)`,
      now,
    );
  }

  const summary = `policy: set ${written.policy.name}=${nextStr}${untilSuffix} at ${parsedLevel.level} (${ctx.target})`;
  if (json) {
    writeJson(rawIo, 'team.policy', {
      format: 1 as const,
      dry_run: false,
      status: 'updated',
      action_summary: summary,
      project: ctx.projectLabel,
      session: ctx.sessionLabel,
      level: parsedLevel.level,
      target: ctx.target,
      policy: written.policy.name,
      value: Array.isArray(written.policy.value) ? [...written.policy.value] : written.policy.value,
      expiry: written.policy.expiry ?? null,
      kind: written.policy.kind,
    });
  } else {
    io.stdout(`${summary}\n`);
  }
  return 'ok';
}

function executePolicyUnset(
  rest: string[],
  values: Record<string, string | undefined>,
  flags: Set<string>,
  rawIo: Io,
  io: Io,
  json: boolean,
  options: PolicyCommandOptions,
): PolicyOutcome {
  if (rest.length !== 2) {
    const why = 'usage: team policy unset <level> <name>';
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', why, null);
    } else {
      io.stderr(`team policy: ${why}\n${USAGE}`);
    }
    return 'invocation';
  }
  if (values.until !== undefined || values.kind !== undefined) {
    const why = '--until and --kind belong to `team policy set`';
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', why, null);
    } else {
      io.stderr(`team policy: ${why}\n${USAGE}`);
    }
    return 'invocation';
  }

  const caller = walkCaller(rawIo);
  if (!isOwner(caller)) {
    const msg = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
    // The owner's dev-mode admission for exactly this gate.
    const lift = devModeOwnerLiftAtCwd(rawIo, { command: 'policy', refusal: msg, home: options.home ?? homedir() });
    // Without the owner terminal, the owner's device: once an owner seat exists, one Touch ID from it.
    const consent = (lift === null || !lift.lifted) && (flags.has('owner-device') || readOwnerSeat(options.home ?? homedir()) !== null)
      ? ownerDeviceConsent(options.home ?? homedir(), options.ownerSeatStore ?? systemOwnerSeatKeyStore(ownerSeatHelperPath(options.home ?? homedir())), { act: 'policy unset', args: rest }, `TeamCLI: policy unset ${rest.join(' ')}`)
      : null;
    if ((lift === null || !lift.lifted) && consent?.ok !== true) {
      if (consent !== null && !consent.ok) io.stderr(`team policy: owner-device consent: ${plainText(consent.why)}\n`);
      if (json) {
        writeJsonError(
          rawIo,
          'policy.refused',
          plainText(msg),
          'the owner runs `team policy unset` from a terminal outside herdr, or confirms it with Touch ID from the owner seat',
          1,
          'owner-only',
        );
      } else {
        io.stderr(`team policy: ${plainText(msg)}\n`);
      }
      return 'refused';
    }
    io.stderr(consent?.ok === true ? `team policy: confirmed on the owner's device by signer ${consent.signer}\n` : `${lift?.warning ?? ''}\n`);
  }

  const [rawLevel, rawName] = rest as [string, string];
  const parsedLevel = parseLevelArg(rawLevel, values.seat);
  if ('error' in parsedLevel) {
    if (json) {
      writeJsonError(rawIo, 'policy.invocation', parsedLevel.error, null);
    } else {
      io.stderr(`team policy: ${parsedLevel.error}\n${USAGE}`);
    }
    return 'invocation';
  }

  const home = options.home ?? homedir();
  const now = resolveNow(options.now);
  const resolvedTarget = resolveWriteTarget(
    home,
    parsedLevel.level,
    parsedLevel.seatName,
    rawName,
    values,
    rawIo.cwd,
  );
  if (!resolvedTarget.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(resolvedTarget.why), null);
    } else {
      io.stderr(`team policy: ${plainText(resolvedTarget.why)}\n`);
    }
    return 'invalid';
  }

  const { ctx } = resolvedTarget;
  const request = {
    level: parsedLevel.level,
    target: ctx.target,
    teamRoot: ctx.teamRoot,
    name: rawName,
  };
  const plan = planPolicyUnset(home, request);
  if (!plan.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(plan.why), null);
    } else {
      io.stderr(`team policy: ${plainText(plan.why)}\n`);
    }
    return 'invalid';
  }

  const dryRun = flags.has('dry-run');
  const prevStr = plan.previous ? formatValueCell(plan.previous.value) : 'unset';
  if (dryRun) {
    const summary = `policy: would unset ${plan.name} at ${parsedLevel.level} (${ctx.target})`;
    if (json) {
      writeJson(rawIo, 'team.policy', {
        format: 1 as const,
        dry_run: true,
        status: 'dry-run',
        action_summary: summary,
        project: ctx.projectLabel,
        session: ctx.sessionLabel,
        level: parsedLevel.level,
        target: ctx.target,
        policy: plan.name,
        value: null,
        plan: [{ step: 'policy', detail: summary, prefix: '+' as const }],
      });
    } else {
      io.stdout(`${summary}\n`);
    }
    return 'ok';
  }

  const written = writePolicyUnset(home, request);
  if (!written.ok) {
    if (json) {
      writeJsonError(rawIo, 'policy.invalid', plainText(written.why), null);
    } else {
      io.stderr(`team policy: ${plainText(written.why)}\n`);
    }
    return 'invalid';
  }

  if (ctx.logDir) {
    logLine(
      ctx.logDir,
      'policy',
      'owner',
      `level ${parsedLevel.level} (${ctx.target}) ${written.name}: ${prevStr} -> unset (setter: owner)`,
      now,
    );
  }

  const summary = `policy: unset ${written.name} at ${parsedLevel.level} (${ctx.target})`;
  if (json) {
    writeJson(rawIo, 'team.policy', {
      format: 1 as const,
      dry_run: false,
      status: 'updated',
      action_summary: summary,
      project: ctx.projectLabel,
      session: ctx.sessionLabel,
      level: parsedLevel.level,
      target: ctx.target,
      policy: written.name,
      value: null,
    });
  } else {
    io.stdout(`${summary}\n`);
  }
  return 'ok';
}
