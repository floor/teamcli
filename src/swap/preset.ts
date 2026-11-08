// The direct preset form. It keeps the queued model-rule form's stop/launch engine, but
// installs a whole recipe at once and never borrows the old conversation's session id.
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { ceilingsOf } from '../approve/approval.ts';
import { describeCaller, fileOwnerRefusal, isOwner, judgeCallerOf, mayChangeTeamVerdict, standingOf, walkCaller } from '../caller.ts';
import type { SwapCommandOptions } from '../commands/swap.ts';
import { performRestart, realSources, type PerformResult } from '../commands/restart.ts';
import { hasSeat, rewriteSeatPreset, type SeatModelFields } from '../file/lines.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { readTeamText, writeTeamText } from '../file/team-text.ts';
import { validateTeamFile } from '../file/validate.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { charterGate } from '../charter/check.ts';
import { loadTeamLaunchers } from '../launch/resolve-flag.ts';
import { launchRefusal, readEntityModelRule } from '../launch/model-guard.ts';
import { plainText } from '../launch/plain.ts';
import { resolveLaunch } from '../launchers/resolve.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { modelRuleAllows } from '../policy/model-rule.ts';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';
import { profileFor, shellQuote, namedResumeTarget } from '../profiles/profile.ts';
import { rosterOf } from '../permissions/who.ts';
import { readState } from '../state.ts';
import { approvalStanding } from '../store/store.ts';
import { createPresetFolder, presetFolder, rollbackPresetFolder, type PresetAllocation } from './folder.ts';

type Recipe = SeatModelFields & { launcher?: string };
const NO_DEV = { on: false, by: null, governed: false, ignored: false, expired: null, refusals: [] };

/** A named launcher is authoritative; a declared seat is an existing complete recipe. */
export function presetRecipe(name: string, team: TeamFile, root: string, cwd: string): Recipe | { why: string } {
  const discovery = loadTeamLaunchers(root);
  const found = discovery.launchers.get(name);
  if (discovery.diagnostics.some(d => d.severity === 'error')) return { why: 'the launcher catalogue cannot be read or validated' };
  if (found === undefined) {
    const donor = team.seats.find(s => s.name === name);
    if (donor === undefined) return { why: `no preset or declared seat named "${name}"` };
    return { cli: donor.cli, vendor: donor.vendor, model: donor.model, version: donor.version,
      display: donor.display, launch: donor.launch, ...(donor.launcher ? { launcher: donor.launcher } : {}),
      ...(donor.modelFrom ? { modelFrom: donor.modelFrom } : {}), ...(donor.effort ? { effort: donor.effort } : {}),
      ...(donor.account ? { account: donor.account } : {}) };
  }
  if (found.def.kind !== 'preset' || found.def.seat === undefined) return { why: 'the preset must declare its seat vendor, model, version and display' };
  const resolved = resolveLaunch({ launcher: name }, discovery, { teamRoot: root, teamHome: `${root}/.agents`, cwd });
  if (!resolved.ok) return { why: resolved.diagnostics.find(d => d.severity === 'error')?.message ?? 'the preset does not resolve' };
  if (resolved.resume.kind !== 'none') return { why: 'a swap preset must start fresh and name no resume selection' };
  if (resolved.env.some(e => 'secret' in e) || Object.keys(resolved.settings).length > 0 || found.def.env_policy?.mode === 'scrub') {
    return { why: 'this preset needs an environment or settings adapter not yet supported by direct swap; use a complete declared-seat recipe' };
  }
  if (found.def.cwd !== undefined && resolved.cwd !== cwd) return { why: 'a swap preset cannot override the seat’s accepted start folder' };
  const env = resolved.env.map(e => 'value' in e ? `${e.name}=${shellQuote(e.value)}` : '');
  return { ...found.def.seat, cli: resolved.harness,
    launch: [...env, ...resolved.argv.map(shellQuote)].join(' '), launcher: name };
}

export async function runPresetSwap(argv: string[], io: Io, options: SwapCommandOptions): Promise<number> {
  const args = readArgs(argv, ['file'], ['dry-run', 'json']);
  const json = hasJsonFlag(argv);
  const fail = (id: string, why: string, code = 1): number => {
    if (json) writeJsonError(io, id, plainText(why), null, code);
    else io.stderr(`team swap: ${plainText(why)}\n`);
    return code;
  };
  if (args.error || args.rest.length !== 2) return fail('swap.invocation', args.error ?? 'expected <seat> <preset>', 2);
  const [name, preset] = args.rest as [string, string];
  const home = options.home ?? homedir();
  const now = typeof options.now === 'function' ? options.now() : options.now ?? new Date();
  const owner = isOwner(walkCaller(io));
  if (!owner && args.values.file !== undefined) {
    const why = fileOwnerRefusal(io, args.values.file);
    if (why !== undefined) return fail('swap.caller', why);
  }
  // No remembered last-valid copy: even an owner's dry run is strictly read-only.
  const current = readTeamConfig(io.cwd, { home, ...(args.values.file !== undefined ? { file: args.values.file } : {}) });
  if (!current.ok) return fail('swap.file', owner ? current.errors.map(p => p.message).join('; ') : 'this team is not yours to read', 2);
  const { team, root, path } = current;
  const dir = dirname(path);
  const judged = judgeCallerOf(io, team.session);
  const roster = rosterOf(home, root);
  if (!owner && (roster.kind === 'unreadable' || (roster.kind === 'listed' && !roster.roster.some(s => judged.caller.kind === 'seat' && s.seat === judged.caller.name)))) {
    return fail('swap.caller', 'the caller has no readable record in this team');
  }
  if (mayChangeTeamVerdict(judged.caller, team, standingOf(dir, team.session, judged.caller)).kind !== 'ok') {
    return fail('swap.caller', 'only the owner or a placed lead or operator of this team swaps a preset');
  }
  // The default-rule lane adds this key to the catalogue. An explicit owner-asks word
  // (or an unreadable chain) must retain its refusal when the two branches are integrated.
  const authority = loadAndResolvePolicyChain({ home, teamRoot: root, team }, { now });
  if (!owner && (!authority.ok || authority.policies['leads.authority']?.value === 'owner-asks')) {
    return fail('swap.caller', 'the authority policy requires the owner for this preset swap');
  }
  if (!owner && name === team.orchestrator) return fail('swap.caller', 'only the owner swaps the orchestrator seat');
  const declared = team.seats.find(s => s.name === name);
  if (!declared || declared.human || declared.stopped) return fail('swap.seat', 'the target must be a declared, active agent seat');
  const recipe = presetRecipe(preset, team, root, declared.cwd);
  if ('why' in recipe) return fail('swap.target', recipe.why);
  const charter = charterGate(home, { operation: 'swap', cwd: root, vendor: recipe.vendor }, options.ownerSeatStore);
  if (charter.kind === 'block') return fail('swap.caller', charter.message);
  if (profileFor(recipe.cli) === null || namedResumeTarget(recipe.cli, recipe.launch) !== null) return fail('swap.target', 'the recipe must name a supported CLI and a fresh launch line');
  const nextBase: Seat = { ...declared, ...recipe };
  for (const k of ['account', 'modelFrom', 'effort', 'launcher'] as const) if (recipe[k] === undefined) delete nextBase[k];
  const rule = readEntityModelRule(home, team);
  if (rule.kind === 'unreadable') return fail('swap.rule', rule.why);
  if (rule.kind === 'rule' && !modelRuleAllows(rule.entries, { name, role: declared.role, vendor: recipe.vendor })) return fail('swap.target', 'the seat policy does not allow this preset’s vendor');
  const policy = launchRefusal(nextBase, rule);
  if (policy !== null) return fail('swap.target', policy);
  const folderInput = { team, seat: declared, cli: recipe.cli, root, dir, home };
  const folder = presetFolder(folderInput);
  if ('why' in folder) return fail('swap.target', folder.why);
  const next = { ...nextBase, cwd: folder.cwd, mode: folder.mode };
  delete next.cwdOutside;
  const fields = { ...recipe, cwd: folder.cwd, mode: folder.mode };
  let before: string;
  try { before = readTeamText(path, { home, command: 'swap' }); }
  catch (error) { return fail('swap.io', String(error)); }
  const text = rewriteSeatPreset(before, name, fields);
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) return fail('swap.target', checked.errors.map(p => p.message).join('; '));
  const changes = Object.fromEntries(['cli', 'vendor', 'model', 'version', 'display', 'launch', 'cwd', 'mode', 'launcher', 'account', 'effort', 'modelFrom'].map(k => {
    const key = k as keyof Seat;
    return [k, { from: declared[key] ?? null, to: next[key] ?? null }];
  }));
  if (args.flags.has('dry-run')) {
    if (json) writeJson(io, 'team.swap', { format: 1, dry_run: true, project: team.project, session: team.session, seat: name, preset,
      status: 'planned', action_summary: `swap: ${name} to ${preset}`, changes, worktree: folder.create ?? null, fresh: true });
    else io.stdout(`swap ${name} to ${preset} (dry run)\n${JSON.stringify(changes, null, 2)}\n${folder.create ? `create worktree ${folder.cwd}\n` : ''}restart fresh\n`);
    return 0;
  }
  const sources = options.sources ?? realSources;
  const agents = sources.agents(team.session);
  if (agents === null) return fail('swap.herdr', 'the terminal host cannot be read');
  const old = agents.find(agent => agent.name === name);
  const screen = old === undefined ? undefined : sources.screen(team.session, old.pane, declared.cli,
    sources.foregroundCwd?.(team.session, old.pane) ?? null);
  const broken = screen?.kind === 'rate limit' || screen?.kind === 'provider error';
  let allocation: PresetAllocation | undefined;
  try { allocation = createPresetFolder(folderInput, folder); }
  catch (error) { return fail('swap.io', String(error)); }
  const notes: string[] = [];
  let declarationWritten = false;
  const rollback = (): string => {
    try { rollbackPresetFolder(folderInput, allocation); return ''; }
    catch (error) { return `; allocation retained: ${String(error)}`; }
  };
  let result: PerformResult;
  try {
    result = await (options.presetRestart ?? performRestart)({ out: io, json, notes, dir, root, home, path, team,
    session: team.session, name, declared, next, recorded: readState(dir).sessions[team.session]?.seats[name], agents,
    abandon: false, broken, owner, callerText: describeCaller(judged.caller), standing: approvalStanding(root, home), ceilings: ceilingsOf(team),
    dev: NO_DEV, devFolded: false, command: 'swap', endReason: 'swap', dry: false, now: () => now, sources,
    resumeNote: 'preset swap starts a fresh conversation',
    declare: () => {
      const live = readTeamText(path, { home, command: 'swap' });
      if (live !== before || !hasSeat(live, name)) return { ok: false, why: 'the team changed while swap was preparing; run it again' };
      const written = writeTeamText(path, text, { home, command: 'swap' });
      declarationWritten = written.ok;
      return written.ok ? { ok: true } : { ok: false, why: written.errors.map(p => p.message).join('; ') };
    },
    });
  } catch (error) {
    return fail('swap.run-failed', String(error) + (declarationWritten ? '' : rollback()));
  }
  if (result.kind !== 'ready') return fail('swap.run-failed', ('message' in result ? result.message : `restart ${result.kind}`) + (declarationWritten ? '' : rollback()));
  if (result.readBack.kind === 'mismatch') return fail('swap.run-failed', 'the new screen does not match the preset model');
  logLine(dir, 'swap', describeCaller(judged.caller), `${name}: preset ${preset}; fresh conversation`, now);
  if (json) writeJson(io, 'team.swap', { format: 1, dry_run: false, project: team.project, session: team.session, seat: name, preset,
    status: 'swapped', action_summary: `swap: ${name} to ${preset}`, changes, fresh: true, pane: result.pane, notes });
  else io.stdout(`swapped: ${name} to ${preset} in ${result.pane} (fresh conversation)\n`);
  return 0;
}
