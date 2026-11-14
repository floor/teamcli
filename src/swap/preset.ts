// The direct preset form. It keeps the queued model-rule form's stop/launch engine, but
// installs a whole recipe at once and never borrows the old conversation's session id.
import { isShippedLauncher } from '../launchers/shipped.ts';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { ceilingsOf } from '../approve/approval.ts';
import { callerLabel, describeCaller, fileOwnerRefusal, isOwner, judgeCallerOf, mayChangeTeamVerdict, standingOf, walkCaller } from '../caller.ts';
import type { SwapCommandOptions } from '../commands/swap.ts';
import { performRestart, realSources, type PerformResult } from '../commands/restart.ts';
import { hasSeat, rewriteSeatPreset, type SeatModelFields } from '../file/lines.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { readTeamText, writeTeamText } from '../file/team-text.ts';
import { validateWithWorkspaceMode } from '../file/load.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { charterGate, passCharterOwner } from '../charter/check.ts';
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

/** What a swap onto a shipped launcher may say about the model; the rest is the launcher's. */
export type ShippedChoice = { model?: string; version?: string; vendor?: string; effort?: string };

const DOTTED = /^\d+(\.\d+)*$/;

/**
 * The recipe for a swap onto a launcher TeamCLI ships: the launcher's CLI, vendor and a default
 * model, which the swap's own --model, --version, --vendor and --effort override. A Claude Code
 * seat keeps the seat's own model when it already runs Claude Code on that vendor; a provider
 * the seat does not already run names its model and version. The launch line is the CLI's name:
 * the launcher builds the rest at launch.
 */
export function shippedRecipe(name: string, choice: ShippedChoice, seat: Seat): Recipe | { why: string } {
  if (choice.version !== undefined && !DOTTED.test(choice.version)) return { why: `--version must be a plain dotted number, not "${choice.version}"` };
  if (choice.effort !== undefined && !/^[a-z]+$/.test(choice.effort)) return { why: `--effort must be one word, not "${choice.effort}"` };
  const pick = (model: string, version: string) => {
    const m = choice.model ?? model;
    const v = choice.version ?? version;
    return { model: m, version: v, display: `${m} ${v}` };
  };
  const effort = choice.effort ?? seat.effort;
  const withEffort = effort === undefined ? {} : { effort };
  switch (name) {
    case 'grok-build':
      if (choice.vendor !== undefined && choice.vendor !== 'xai') return { why: 'grok-build runs xAI models only' };
      return { cli: 'grok', vendor: 'xai', ...pick('Grok', '4.7'), launch: 'grok', launcher: name, ...withEffort };
    case 'codex':
      if (choice.vendor !== undefined && choice.vendor !== 'openai') return { why: 'codex runs OpenAI models only' };
      return { cli: 'codex', vendor: 'openai', ...pick('GPT Sol', '6.1'), launch: 'codex', launcher: name, ...withEffort };
    case 'antigravity': {
      const vendor = choice.vendor ?? 'google';
      if (vendor !== 'google') return { why: 'antigravity runs Gemini models only through this launcher' };
      return { cli: 'antigravity', vendor, ...pick('Gemini Argon', '4'), launch: 'agy', launcher: name, effort: effort ?? 'high' };
    }
    case 'claude-code': {
      const vendor = choice.vendor ?? (seat.cli === 'claude-code' ? seat.vendor : 'anthropic');
      const keeps = seat.cli === 'claude-code' && seat.vendor === vendor;
      const model = choice.model ?? (keeps ? seat.model : undefined);
      const version = choice.version ?? (keeps ? seat.version : undefined);
      if (model === undefined || version === undefined) {
        return { why: `name the model with --model and --version: the seat does not already run claude-code on ${vendor}` };
      }
      return { cli: 'claude-code', vendor, model, version, display: `${model} ${version}`, launch: 'claude', launcher: name, ...withEffort };
    }
    default:
      return { why: `no shipped launcher named "${name}"` };
  }
}

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
  const args = readArgs(argv, ['file', 'model', 'version', 'vendor', 'effort'], ['dry-run', 'json']);
  const json = hasJsonFlag(argv);
  const fail = (id: string, why: string, code: 1 | 2 = 1): number => {
    if (json) writeJsonError(io, id, plainText(why), null, code);
    else io.stderr(`team swap: ${plainText(why)}\n`);
    // exit: swap.preset-refused
    // exit: swap.preset-unreadable
    return code === 2 ? 2 : 1;
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
  // A launcher TeamCLI ships is its own recipe; its model options apply to it alone.
  const choice: ShippedChoice = {
    ...(args.values.model === undefined ? {} : { model: args.values.model }),
    ...(args.values.version === undefined ? {} : { version: args.values.version }),
    ...(args.values.vendor === undefined ? {} : { vendor: args.values.vendor }),
    ...(args.values.effort === undefined ? {} : { effort: args.values.effort }),
  };
  if (!isShippedLauncher(preset) && Object.keys(choice).length > 0) {
    return fail('swap.invocation', '--model, --version, --vendor and --effort apply to a shipped launcher (grok-build, claude-code, codex, antigravity)', 2);
  }
  const recipe = isShippedLauncher(preset)
    ? shippedRecipe(preset, choice, declared)
    : presetRecipe(preset, team, root, declared.cwd);
  if ('why' in recipe) return fail('swap.target', recipe.why);
  const charter = charterGate(home, { operation: 'swap', cwd: root, vendor: recipe.vendor }, options.ownerSeatStore);
  if (charter.kind === 'block' && !owner) return fail('swap.caller', charter.message);
  if (charter.kind === 'block') passCharterOwner(io, charter.message, { dir, command: 'swap', caller: callerLabel(walkCaller(io)), now });
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
  // The same validation the loader runs: a team whose workspace mode comes from its policy chain
  // (no `workspace.mode` in the record) is not held to the worktree default's requirements.
  const checked = validateWithWorkspaceMode(text, root, { home });
  if (!checked.ok) return fail('swap.target', checked.errors.map(p => p.message).join('; '));
  const changes = Object.fromEntries(['cli', 'vendor', 'model', 'version', 'display', 'launch', 'cwd', 'mode', 'launcher', 'account', 'effort', 'modelFrom'].map(k => {
    const key = k as keyof Seat;
    return [k, { from: declared[key] ?? null, to: next[key] ?? null }];
  }));
  if (args.flags.has('dry-run')) {
    if (json) writeJson(io, 'team.swap', { format: 1, dry_run: true, project: team.project, session: team.session, seat: name, preset,
      status: 'planned', action_summary: `swap: ${name} to ${preset}`, changes, worktree: folder.create ?? null, fresh: true });
    else io.stdout(`swap ${name} to ${preset} (dry run)\n${JSON.stringify(changes, null, 2)}\n${folder.create ? `create worktree ${folder.cwd}\n` : ''}restart fresh\n`);
    return 0; // exit: swap.preset-planned
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
      // The recipe is built from the team as read, its words filled: they are written back as words.
      const written = writeTeamText(path, text, { home, command: 'swap', keepWords: true });
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
  return 0; // exit: swap.preset-swapped
}
