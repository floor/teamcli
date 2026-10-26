// `team batch`: one owner-seat request for several actions.
//
// Each action is bound the way that command's own --request binds it (repository, team, HEAD,
// and the hash of its arguments). One card and one Touch ID answer the whole list. --approval
// runs every action once. The actions never grant, never change owner-signers and never change
// approval-mode, so no principal widens its own authority through the batch.

import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerLabel, callerOf } from '../caller.ts';
import { admitOwnerAction, boundWords, createOwnerActionRequest, OWNER_ACTION_ID_PATTERN, readOwnerActionRecord, type OwnerAction } from '../client/owner-action.ts';
import { headOf, teamNameAt } from '../client/owner-action-step.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { actionApprovalsFolder, TEAM_CREATE_ID_PATTERN } from '../client/team-create.ts';
import { findRoot } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag } from '../output/index.ts';
import { findTeams } from '../registry/teams.ts';
import { runAdd } from './add.ts';
import { runApprovals } from './approvals.ts';
import { runBus } from './bus.ts';
import { runDown, realSources as downSources } from './down.ts';
import { runForget } from './forget.ts';
import { runImport } from './import.ts';
import { realHost, runSend } from './send.ts';
import { runUp, realSources as upSources } from './up.ts';

export const USAGE = `Usage: team batch --request --do <command> [--json]
       team batch --approval <request-id> [--dry-run] [--json]

Records several owner-seat actions as one request, or runs that request once the owner has
answered. Repeat --do, once per command. The words after --do are that command and its
arguments: approvals revoke and its rule ids, or forget and its team ids, or up, add, import,
send, down, bus with the arguments that command would take. Each command is bound as its own
--request would bind it: repository, team, HEAD, and the hash of its arguments. One card and
one Touch ID cover the whole list.

--approval runs every action in the recorded list, each once. --dry-run checks the answer and
changes nothing. Before anything runs, every action must be one this request admits, and every
revoke id and forget id must resolve; otherwise nothing runs. A command here does not grant,
does not change owner-signers, and does not change approval-mode.

Exits 0 when the request is recorded or the batch has run, 1 when it is refused, 2 when the
invocation can't be read.
`;

const BATCHABLE: Record<string, OwnerAction> = {
  up: 'team-up',
  add: 'team-add',
  import: 'team-import',
  send: 'team-send',
  down: 'team-down',
  bus: 'team-bus',
  approvals: 'team-revoke-approval',
  forget: 'team-forget',
};

const COMMAND_OF: Partial<Record<OwnerAction, string>> = Object.fromEntries(Object.entries(BATCHABLE).map(([command, action]) => [action, command]));

export type BatchSources = { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore };

export const batch: Command = (argv, io) => runBatch(argv, io);
export default batch;

type Parsed = { request: boolean; approval: string | undefined; dry: boolean; json: boolean; pieces: string[][] };
type Item = { command: string; action: OwnerAction; argv: string[] };

export async function runBatch(argv: string[], io: Io, sources: BatchSources = {}): Promise<number> {
  const parsed = parseBatch(argv);
  if ('error' in parsed) {
    io.stderr(`team batch: ${parsed.error}\n${USAGE}`);
    // exit: batch.invocation
    return 2;
  }
  const home = sources.home ?? homedir();
  const now = sources.now?.() ?? new Date();
  const json = parsed.json || hasJsonFlag(argv);
  const outcome = await perform(parsed, io, { ...sources, home, now: () => now }, json);
  if (outcome === 'requested') {
    // exit: batch.requested
    return 0;
  }
  if (outcome === 'done') {
    // exit: batch.done
    return 0;
  }
  // exit: batch.refused
  return 1;
}

async function perform(parsed: Parsed, io: Io, sources: BatchSources & { home: string; now: () => Date }, json: boolean): Promise<'requested' | 'done' | 'refused'> {
  const root = findRoot(io.cwd);
  if (root === null) return say(io, json, 'not inside a git repository');
  const home = sources.home;
  const team = teamNameAt(root, home);
  const head = headOf(root);
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  if (parsed.request) {
    const compiled = compile(parsed.pieces);
    if (!compiled.ok) return say(io, json, compiled.why);
    const args: Partial<Record<OwnerAction, string[]>> = {};
    for (const item of compiled.items) args[item.action] = boundWords(item.argv);
    const made = createOwnerActionRequest(home, {
      actions: compiled.items.map((item) => item.action),
      root,
      team,
      head,
      args,
      requestedBy: callerLabel(callerOf(io)),
    }, sources.now());
    if (!made.ok) return say(io, json, made.why);
    const where = made.page === 'live' ? 'the owner page is already open and will show this card' : 'the owner answers it on the owner page';
    const run = `team batch --approval ${made.record.request_id}`;
    if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'requested', request_id: made.record.request_id, expires_at: made.record.expires_at, page: made.page, actions: made.record.params.actions, text: made.text, run })}\n`);
    else io.stdout(`team batch: owner-seat request ${made.record.request_id} recorded; ${where}\none signature covers ${String(made.record.params.actions.length)} actions\nthen run: ${run}\n`);
    return 'requested';
  }
  const record = readOwnerActionRecord(home, parsed.approval!);
  if (typeof record === 'string') return say(io, json, record);
  const items: Item[] = [];
  for (const action of record.params.actions) {
    const command = COMMAND_OF[action];
    const words = record.params.words?.[action];
    if (command === undefined || words === undefined) return say(io, json, `request ${record.request_id} includes ${action}, which team batch does not run`);
    items.push({ command, action, argv: [...words] });
  }
  for (const item of items) {
    const admitted = admitOwnerAction(home, record.request_id, { action: item.action, root, team, head, words: item.argv, claim: false }, store, sources.now());
    if (!admitted.ok) return say(io, json, admitted.why);
  }
  const blocked = targetsReady(home, items);
  if (blocked !== null) return say(io, json, blocked);
  if (parsed.dry) {
    const plan = items.map((item) => `${item.command} ${item.argv.join(' ')}`.trim()).join('; ');
    if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'dry-run', request_id: record.request_id, plan })}\n`);
    else io.stdout(`team batch: ${record.request_id} would run ${plan}\ndry run: nothing was run\n`);
    return 'done';
  }
  const seat = { home, now: sources.now, ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  const captured: string[] = [];
  const target: Io = json ? { ...io, stdout: (text) => { captured.push(text); }, stderr: (text) => { captured.push(text); } } : io;
  for (const item of items) {
    const code = await dispatch(item.command, [...item.argv, '--approval', record.request_id], target, seat);
    if (code !== 0) {
      if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'refused', request_id: record.request_id, command: item.command, output: captured.join('') })}\n`);
      return 'refused';
    }
  }
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'ran', request_id: record.request_id, commands: items.map((item) => item.command), output: captured.join('') })}\n`);
  else io.stdout(`team batch: ran ${String(items.length)} actions\n`);
  return 'done';
}

/** Every revoke id is a rule file and every forget key names one team. Nothing is changed here. */
function targetsReady(home: string, items: readonly Item[]): string | null {
  for (const item of items) {
    if (item.command === 'approvals') {
      const ids = item.argv.slice(1);
      const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
      if (repeated !== undefined) return `"${repeated}" is repeated; nothing was run`;
      for (const id of ids) {
        const teamCreate = TEAM_CREATE_ID_PATTERN.test(id);
        const ownerAction = OWNER_ACTION_ID_PATTERN.test(id);
        if (!teamCreate && !ownerAction) return `"${id}" is not an approval rule id; nothing was run`;
        try {
          if (!lstatSync(join(actionApprovalsFolder(home), `${id}.json`)).isFile()) throw new Error('kind');
        } catch {
          return `${teamCreate ? 'no team-create rule' : 'no owner-action rule'} ${id}; nothing was run`;
        }
      }
    }
    if (item.command === 'forget') {
      const seen = new Set<string>();
      for (const key of item.argv) {
        let found;
        try {
          found = findTeams(home, key);
        } catch (error) {
          return `the team registry cannot be read: ${error instanceof Error ? error.message : String(error)}; nothing was run`;
        }
        if (found.length === 0) return `no team record for "${key}"; nothing was run`;
        if (found.length > 1) return `"${key}" names ${String(found.length)} teams (${found.map((team) => team.id).join(', ')}); nothing was run`;
        const id = found[0]?.id;
        if (id === undefined) return 'the team record has no id; nothing was run';
        if (seen.has(id)) return `"${key}" names ${id}, which is already in this forget; nothing was run`;
        seen.add(id);
      }
    }
  }
  return null;
}

function say(io: Io, json: boolean, message: string): 'refused' {
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'refused', message })}\n`);
  else io.stderr(`team batch: ${message}\n`);
  return 'refused';
}

function compile(pieces: string[][]): { ok: true; items: Item[] } | { ok: false; why: string } {
  const items: Item[] = [];
  for (const words of pieces) {
    const command = words[0];
    if (command === undefined) return { ok: false, why: '--do needs a command' };
    const action = BATCHABLE[command];
    if (action === undefined) return { ok: false, why: `"${command}" is not a command a batch can ask for` };
    const argv = words.slice(1);
    if (command === 'approvals' && (argv[0] !== 'revoke' || argv.length < 2)) return { ok: false, why: 'revoke needs at least one id' };
    if (command === 'forget' && argv.length < 1) return { ok: false, why: 'forget needs at least one id' };
    const prior = items.find((item) => item.action === action);
    if (prior !== undefined) {
      if (command !== 'approvals' && command !== 'forget') return { ok: false, why: `${action} is already in this batch; one request binds one argument list for it` };
      prior.argv = command === 'approvals' ? ['revoke', ...prior.argv.slice(1), ...argv.slice(1)] : [...prior.argv, ...argv];
      continue;
    }
    items.push({ command, action, argv: [...argv] });
  }
  if (items.length === 0) return { ok: false, why: 'pass --request and one or more --do <command>, or --approval <request-id>' };
  return { ok: true, items };
}

function parseBatch(argv: string[]): Parsed | { error: string } {
  const flagWords: string[] = [];
  const pieces: string[][] = [];
  let current: string[] | null = null;
  const switches = new Set(['request', 'json', 'dry-run']);
  const valued = new Set(['approval']);
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === '--do') {
      current = [];
      pieces.push(current);
      continue;
    }
    if (word.startsWith('--do=')) return { error: '--do takes the command that follows it' };
    const named = word.startsWith('--') ? word.slice(2).split(/=(.*)/s)[0]! : '';
    if (switches.has(named) || valued.has(named)) {
      flagWords.push(word);
      if (valued.has(named) && !word.includes('=')) {
        const value = argv[++i];
        if (value === undefined || value === '') return { error: `--${named} needs a value` };
        flagWords.push(value);
      }
      continue;
    }
    if (current === null) return { error: word.startsWith('--') ? `unknown option ${word}` : `unexpected "${word}"` };
    current.push(word);
  }
  if (pieces.some((piece) => piece.length === 0)) return { error: '--do needs a command' };
  const args = readArgs(flagWords, ['approval', 'do'], ['json', 'request', 'dry-run']);
  if (args.error) return { error: args.error };
  const request = args.flags.has('request');
  const approval = args.values.approval;
  if (request && approval !== undefined) return { error: '--request asks the owner seat and --approval runs an answered request: pass one' };
  if (args.flags.has('dry-run') && approval === undefined) return { error: '--dry-run checks an answered request: pass --approval <request-id>' };
  if (approval !== undefined && pieces.length > 0) return { error: '--approval runs the recorded batch and takes no --do' };
  if (request && pieces.length === 0) return { error: 'pass --request and one or more --do <command>, or --approval <request-id>' };
  if (!request && approval === undefined) return { error: 'pass --request and one or more --do <command>, or --approval <request-id>' };
  if (request) {
    const compiled = compile(pieces);
    if (!compiled.ok) return { error: compiled.why };
  }
  return { request, approval, dry: args.flags.has('dry-run'), json: args.flags.has('json'), pieces };
}

async function dispatch(command: string, argv: string[], io: Io, sources: BatchSources): Promise<number> {
  const seat = { ...(sources.home !== undefined ? { home: sources.home } : {}), ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  switch (command) {
    case 'approvals': return runApprovals(argv, io, seat);
    case 'forget': return runForget(argv, io, seat);
    case 'up': return runUp(argv, io, upSources);
    case 'down': return runDown(argv, io, downSources);
    case 'add': return runAdd(argv, io);
    case 'import': return runImport(argv, io, seat);
    case 'send': return runSend(argv, io, { ...realHost, ...(sources.home !== undefined ? { home: sources.home } : {}), ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) });
    case 'bus': return runBus(argv, io, seat);
    default: return 1;
  }
}
