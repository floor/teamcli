// A hand-started seat uses the same bounded project pair, config gate and register writer.
import { lstatSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf } from '../caller.ts';
import { runConfig, type ConfigSources } from '../commands/config.ts';
import { runRegister, realSources as registerSources, type RegisterSources } from '../commands/register.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import type { Io } from '../io.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { cliBodyOn, cliWordListOf, plainBodyOf, placedOnLaunchLine } from '../launch/cli-scope.ts';
import { shellWords } from '../launch/shell-words.ts';
import { plainLine } from '../launch/plain.ts';
import { refuse, writeJson } from '../output/index.ts';
import { teamBinding } from '../registry/binding.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER, channelLaunchEnabled } from './channel.ts';
import { jsonValueText, removeJsonName, setJsonValue } from './json-text.ts';
import { ConfigRefusal, channelDirectory, channelDocument, ownedEntry, planChannelPair, publishChannelPair, type ChannelPairPlan, type ChannelWrite } from './launch-config.ts';

export type McpSetupSources = { config?: ConfigSources; register?: RegisterSources };
type SavedFile = { before: string | null; after: string };
type Journal = {
  format: 1; root: string; cwd: string; seat: string; session: string;
  launchBefore: string; launchAfter: string; approvalFolderCreated: boolean;
  files: [SavedFile, SavedFile];
};
export const CHANNEL_SETUP_RECORD = '.team-channel-setup.json';
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorText(value: unknown): string { return value instanceof SyntaxError ? 'the setup record contains invalid JSON' : value instanceof Error ? value.message : 'the setup could not be safely read or written'; }
function contains(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
/** Setup changes its starting folder, so the folder selects the team, never the seat name.
 * A local definition wins; otherwise the closest containing registered root owns the folder.
 * The ordinary config reader still decides the source and validates the chosen root. */
function setupRoot(home: string, cwd: string, io?: Io): string | null {
  try {
    const agents = lstatSync(join(cwd, '.agents'));
    if (agents.isSymbolicLink()) throw new ConfigRefusal('the starting folder has a linked team directory');
    if (agents.isDirectory()) {
      const file = lstatSync(join(cwd, '.agents/team.yaml'));
      if (file.isSymbolicLink() || !file.isFile()) throw new ConfigRefusal('the starting folder has no real team file');
      return cwd;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const binding = teamBinding(home, cwd, undefined, io);
  if (binding.kind === 'unreadable' || binding.kind === 'ambiguous') throw new ConfigRefusal(binding.message);
  return binding.kind === 'bound' ? resolve(binding.team.root) : null;
}
function enable(launch: string): string {
  const decoded = cliWordListOf('claude', launch);
  const body = cliBodyOn('claude', launch) ?? plainBodyOf(launch);
  if (decoded === null || body === null) throw new Error('the launch flag cannot be placed safely on this launch line');
  const words = shellWords(body.text)!;
  const delimiter = words.findIndex((word) => word.text === '--');
  const options = delimiter < 0 ? words : words.slice(0, delimiter);
  const flags = options.filter((word) => word.text === CHANNEL_FLAG || word.text.startsWith(`${CHANNEL_FLAG}=`));
  if (flags.length > 1) throw new Error('the launch line has competing development-channel flags');
  const flag = flags[0];
  if (flag !== undefined) {
    const next = options[options.indexOf(flag) + 1];
    const value = flag.text === CHANNEL_FLAG ? next?.text : flag.text.slice(CHANNEL_FLAG.length + 1);
    if (value === undefined || !/^[A-Za-z0-9:_,.-]+$/.test(value) || value.startsWith('-')) throw new Error('the existing development-channel flag has no safe server list');
    const names = value.split(',');
    if (names.includes(`server:${CHANNEL_SERVER}`) && channelLaunchEnabled(launch)) return launch;
    if (!names.includes(`server:${CHANNEL_SERVER}`)) names.push(`server:${CHANNEL_SERVER}`);
    const end = flag.text === CHANNEL_FLAG ? next!.end : flag.end;
    // Keep a wrapped command's closing quote off the canonical server-list token: the
    // existing channel declaration reader must recognize the flag we just wrote as well.
    const separator = body.end < launch.length && end === body.text.length ? ' ' : '';
    const changed = launch.slice(0, body.start + flag.start) + `${CHANNEL_FLAG} ${names.join(',')}${separator}` + launch.slice(body.start + end);
    if (!channelLaunchEnabled(changed)) throw new Error('the channel declaration cannot read the prepared launch flag');
    return changed;
  }
  const added = placedOnLaunchLine(launch, `${CHANNEL_FLAG} server:${CHANNEL_SERVER}${body.end < launch.length ? ' ' : ''}`, 'claude');
  if (added === null || !channelLaunchEnabled(added)) throw new Error('the launch flag cannot be placed safely on this launch line');
  return added;
}
function readJournal(doc: ReturnType<typeof channelDocument>, scope: Pick<Journal, 'root' | 'cwd' | 'seat' | 'session'>): Journal | null {
  if (doc.before === undefined) return null;
  if ((lstatSync(doc.path).mode & 0o7777) !== 0o600) throw new Error('the setup record must be an owned private file');
  const value = doc.value;
  if (value.format !== 1 || !['root', 'cwd', 'seat', 'session'].every((key) => value[key] === scope[key as keyof typeof scope])
    || typeof value.launchBefore !== 'string' || typeof value.launchAfter !== 'string'
    || typeof value.approvalFolderCreated !== 'boolean' || !Array.isArray(value.files) || value.files.length !== 2) throw new Error('the existing setup record belongs to another configuration');
  const owner = JSON.stringify({ v: 1, team: teamIdOf(scope.root), seat: scope.seat, session: scope.session });
  for (const [index, file] of value.files.entries()) {
    if (!object(file) || (file.before !== null && typeof file.before !== 'string') || typeof file.after !== 'string') throw new Error('the setup record is malformed');
    for (const text of [file.before, file.after]) {
      if (text === null) continue;
      const parsed: unknown = JSON.parse(text as string);
      if (!object(parsed)) throw new Error('the setup record contains an invalid project document');
      if (index === 0) {
        const raw = jsonValueText(text as string, ['mcpServers', CHANNEL_SERVER]);
        if ((text === file.after || raw !== undefined) && (raw === undefined || !ownedEntry(JSON.parse(raw), owner, scope.seat, scope.session))) throw new Error('the setup record does not hold its owned server entry');
      } else if (parsed.enabledMcpjsonServers !== undefined && (!Array.isArray(parsed.enabledMcpjsonServers) || parsed.enabledMcpjsonServers.some((v) => typeof v !== 'string'))) throw new Error('the setup record contains invalid approval names');
    }
  }
  return value as unknown as Journal;
}
function offDocuments(plan: ChannelPairPlan, journal: Journal): ChannelWrite[] {
  return plan.documents.map(({ doc }, index) => {
    const saved = journal.files[index]!;
    if (doc.before === saved.after || doc.before === (saved.before ?? undefined)) return { doc, text: saved.before ?? undefined };
    if (doc.before === undefined) throw new Error('a setup project document was removed after setup');
    let text = doc.before;
    if (index === 0) {
      const after = jsonValueText(saved.after, ['mcpServers', CHANNEL_SERVER]);
      const prior = saved.before === null ? undefined : jsonValueText(saved.before, ['mcpServers', CHANNEL_SERVER]);
      const current = jsonValueText(text, ['mcpServers', CHANNEL_SERVER]);
      if (current !== after && current !== prior) throw new Error('the setup-owned server entry changed; it was not removed');
      text = setJsonValue(text, ['mcpServers', CHANNEL_SERVER], prior);
      if ((saved.before === null || jsonValueText(saved.before, ['mcpServers']) === undefined)
        && jsonValueText(text, ['mcpServers']) !== undefined && Object.keys(JSON.parse(jsonValueText(text, ['mcpServers'])!)).length === 0) text = setJsonValue(text, ['mcpServers'], undefined);
    } else {
      const prior = saved.before === null ? undefined : jsonValueText(saved.before, ['enabledMcpjsonServers']);
      const names = prior === undefined ? [] : JSON.parse(prior) as string[];
      if (!names.includes(CHANNEL_SERVER)) text = removeJsonName(text, 'enabledMcpjsonServers', CHANNEL_SERVER, prior === undefined);
    }
    return { doc, text: saved.before === null && Object.keys(JSON.parse(text)).length === 0 ? undefined : text };
  });
}

export async function runMcpSetup(args: ReturnType<typeof readArgs>, json: boolean, io: Io, home: string, sources: McpSetupSources = {}): Promise<number> {
  const fail = (id: string, message: string) => { refuse(io, json, 'mcp setup', { id, message, repair: null }); };
  if (args.error !== undefined || Object.keys(args.values).length !== 0 || args.rest.length !== 1 || !SEAT_NAME.test(args.rest[0] ?? '')) {
    fail('mcp.setup-invocation', args.error ?? 'one declared seat name and only --off, --dry-run or --json are accepted');
    return 2; // exit: mcp.setup-invocation
  }
  const name = args.rest[0]!; const dry = args.flags.has('dry-run'); const off = args.flags.has('off');
  try {
    const cwd = resolve(io.cwd); channelDirectory(cwd, false);
    const selectedRoot = setupRoot(home, cwd, io);
    if (selectedRoot === null) {
      fail('mcp.setup-team', 'run setup from a team folder: this folder has no local team file or containing registered team');
      return 1; // exit: mcp.setup-team-root
    }
    const loaded = readTeamConfig(selectedRoot, { home, ...(sources.config?.env === undefined ? {} : { env: sources.config.env }) });
    if (!loaded.ok || resolve(loaded.root) !== selectedRoot || !contains(selectedRoot, cwd)) {
      fail('mcp.setup-team', 'the team selected by this starting folder cannot be read at its own root');
      return 1; // exit: mcp.setup-team-read
    }
    const { team, root } = loaded; const seat = team.seats.find((one) => one.name === name);
    if (seat === undefined || seat.stopped || seat.human || seat.cli !== 'claude-code') {
      fail('mcp.setup-seat', 'setup requires a declared, running Claude seat');
      return 1; // exit: mcp.setup-seat
    }
    const caller = callerOf(io, team.session);
    if (caller.kind !== 'owner' && !(caller.kind === 'seat' && caller.name === name && (caller.session === undefined || caller.session === team.session))) {
      fail('mcp.setup-caller', 'only the owner or this seat itself sets up its channel');
      return 1; // exit: mcp.setup-caller
    }
    const scope = { root, cwd, seat: name, session: team.session };
    const record = channelDocument(join(cwd, CHANNEL_SETUP_RECORD)); const journal = readJournal(record, scope);
    if (journal !== null && seat.launch !== journal.launchAfter && seat.launch !== journal.launchBefore) {
      fail('mcp.setup-changed', 'the setup-owned launch line changed; it was left untouched');
      return 1; // exit: mcp.setup-changed
    }
    const launch = off ? journal?.launchBefore ?? seat.launch : enable(seat.launch);
    let configOutput = '';
    const internalIo: Io = { ...io, cwd: root, stdout: (text) => { configOutput += text; }, stderr: (text) => { configOutput += text; } };
    const configArgs = ['set', `seats.${name}.launch`, JSON.stringify(launch), '--json'];
    const config = { ...sources.config, home };
    const configReason = () => {
      for (const line of configOutput.trim().split('\n').reverse()) {
        try {
          const value: unknown = JSON.parse(line);
          if (object(value) && object(value.error) && typeof value.error.message === 'string') return `: ${value.error.message}`;
        } catch { /* warnings and plain lines carry no structured refusal */ }
      }
      return '';
    };
    const allowed = await runConfig(configArgs, internalIo, { ...config, planOnly: true });
    if (allowed !== 0) {
      fail('mcp.setup-config', `the existing config editor refused the launch-line change${configReason()}; no setup files or placement were written`);
      return 1; // exit: mcp.setup-config-preflight
    }
    if (off && journal === null) {
      if (json) writeJson(io, 'team.mcp-setup', { format: 1, seat: name, session: team.session, cwd, dry_run: dry, status: 'unchanged', changes: [] });
      else io.stdout(`team mcp setup ${plainLine(name)}: nothing owned by setup in this folder\n`);
      return 0; // exit: mcp.setup-unchanged
    }
    const stateDir = dirname(loaded.path);
    const claim = () => readState(stateDir).sessions[team.session]?.briefs?.[name];
    let claimBefore = JSON.stringify(claim() ?? null);
    const plan = planChannelPair({ ...scope, epoch: currentBriefClaim(claim())?.epoch }, false);
    // Validate restoration before any config or placement write, too.
    const restored = journal === null ? null : offDocuments(plan, journal);
    const pane = caller.kind === 'seat' ? caller.pane : io.env.HERDR_PANE_ID;
    const register = { ...registerSources, ...sources.register, home };
    if (!off) {
      if (pane === undefined || pane === '') {
        fail('mcp.setup-placement', 'run setup from the pane this seat starts in');
        return 1; // exit: mcp.setup-pane-required
      }
      const checked = await runRegister([name, '--session', team.session, '--pane', pane, '--dry-run', '--json'], internalIo, register);
      if (checked !== 0) {
        fail('mcp.setup-placement', 'the existing registration writer refused the calling pane; nothing was written');
        return 1; // exit: mcp.setup-placement-preflight
      }
    }
    const changes = [
      { kind: 'project-config', action: off ? 'restore' : 'prepare', paths: ['.mcp.json', '.claude/settings.local.json'] },
      { kind: 'launch', action: off ? 'restore' : 'enable', path: `seats.${name}.launch` },
      { kind: 'placement', action: off ? 'keep' : 'record', pane: pane ?? null },
    ];
    const report = () => {
      if (json) writeJson(io, 'team.mcp-setup', { format: 1, seat: name, session: team.session, cwd, dry_run: dry, status: off ? 'off' : 'setup', changes });
      else for (const change of changes) io.stdout(`team mcp setup ${plainLine(name)}: ${dry ? 'would ' : ''}${change.action} ${change.kind}\n`);
    };
    if (dry) {
      report(); return 0; // exit: mcp.setup-planned
    }
    // Refuse through the real config writer before publishing either config or placement.
    configOutput = '';
    if (await runConfig(configArgs, internalIo, config) !== 0) {
      fail('mcp.setup-config', `the config editor refused the launch-line change${configReason()}; no setup files or placement were written`);
      return 1; // exit: mcp.setup-config-write
    }
    if (!off) {
      // Registration owns attribution and may create a brief claim. Bind the project pair to
      // that resulting lifetime, never to the pre-registration epoch. Keep the original file
      // snapshots so a concurrent project edit cannot be adopted silently by the second plan.
      if (await runRegister([name, '--session', team.session, '--pane', pane!, '--json'], internalIo, register) !== 0) {
        fail('mcp.setup-placement', 'registration refused after preflight; the launch change remains and no project pair was published');
        return 1; // exit: mcp.setup-placement-write
      }
      if (!record.unchanged() || plan.documents.some(({ doc }) => !doc.unchanged())) throw new Error('the setup project documents changed during registration');
      claimBefore = JSON.stringify(claim() ?? null);
      const rebound = planChannelPair({ ...scope, epoch: currentBriefClaim(claim())?.epoch }, false);
      plan.documents = plan.documents.map(({ doc }, index) => ({ doc, text: rebound.documents[index]!.text }));
    }
    const saved: Journal = journal === null
      ? { format: 1, ...scope, launchBefore: seat.launch, launchAfter: launch, approvalFolderCreated: plan.approvalFolder === null,
          files: plan.documents.map(({ doc, text }) => ({ before: doc.before ?? null, after: text! })) as [SavedFile, SavedFile] }
      : { ...journal, launchAfter: launch,
          files: plan.documents.map(({ text }, index) => ({ before: restored![index]!.text ?? null, after: text! })) as [SavedFile, SavedFile] };
    const guard = () => {
      if (setupRoot(home, cwd, io) !== root) throw new ConfigRefusal('the starting folder no longer resolves to this team');
      const current = readTeamConfig(root, { home, ...(config.env === undefined ? {} : { env: config.env }) });
      const declared = current.ok ? current.team.seats.find((one) => one.name === name) : undefined;
      if (!current.ok) throw new ConfigRefusal('the registered team became unreadable during setup');
      if (current.team.session !== team.session || declared === undefined || declared.stopped || declared.human || declared.cli !== 'claude-code') throw new ConfigRefusal('the declared seat changed during setup');
      if (declared.launch !== launch) throw new ConfigRefusal('the launch line changed during setup');
      if (JSON.stringify(claim() ?? null) !== claimBefore) throw new ConfigRefusal('the launch claim changed during setup');
    };
    if (off) plan.documents = offDocuments(plan, journal!);
    const wrote = publishChannelPair(plan, guard, [{ doc: record, text: off ? undefined : `${JSON.stringify(saved)}\n` }], undefined, off);
    if (!wrote.ok) {
      fail('mcp.setup-write', wrote.reason);
      return 1; // exit: mcp.setup-write
    }
    try {
      wrote.lease.check();
    } finally { wrote.lease.release(); }
    if (off && journal!.approvalFolderCreated) {
      // Remove only the empty owned directory setup created; unrelated files keep it alive.
      try { channelDirectory(join(cwd, '.claude'), false); rmdirSync(join(cwd, '.claude')); } catch { /* not empty or no longer ours */ }
    }
    report(); return 0; // exit: mcp.setup-written
  } catch (error) {
    fail('mcp.setup-unsafe', errorText(error));
    return 1; // exit: mcp.setup-unsafe
  }
}
