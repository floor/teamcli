// Source: lead decision 2026-11-11 02:30Z, following the cross-lab model-follows-cli read:
// model-only drift delivers and flags; an observation never relaxes the entity model rule.
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readStateFile, writeStateFile } from '../file-write.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { plainLine } from '../launch/plain.ts';
import { readEntityModelRule, type EntityModelRule } from '../policy/entity-rule.ts';
import { labOfModel, modelRuleAllows, modelRuleEntryFor, modelRuleSentence, modelRuleUnknownSentence } from '../policy/model-rule.ts';
import { findAgent, type Agent } from '../registry/agents.ts';
import { paneHoldsOnlyShell } from '../launch/identity.ts';
import { teamIdOf } from '../registry/teams.ts';
import { pidAlive, withLock } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { modelDiffers, signedSeatModel, type Running } from '../status/statusline.ts';
import { ensureFoldersBelow } from './history.ts';
import { PENDING_ID } from './pending.ts';
import { recordNameOk } from './record.ts';

export type ModelDrift = { recipient: string; recorded: Running; observed: Running };
type Scope = { dir: string; root: string; session: string; seat: string };
type Episode = ModelDrift & { id: string; at: string; lead: string; leadId: string | null; state: 'sending' | 'recorded' | 'failed' | 'uncertain'; pid: number; detail: string };

/** The proposed observation is judged as a model, never as the file's old vendor word. */
export function observedModelRefusal(seat: { name: string; role: string }, observed: Running, rule: EntityModelRule): string | null {
  if (rule.kind === 'none') return null;
  if (rule.kind === 'unreadable') return `the entity model rule cannot be read (${rule.why})`;
  if (modelRuleEntryFor(rule.entries, seat) === undefined) return null;
  const lab = labOfModel(observed.model);
  if (lab === undefined) return modelRuleUnknownSentence(observed.model);
  return modelRuleAllows(rule.entries, { ...seat, vendor: lab }) ? null : modelRuleSentence(observed.model, lab);
}

export function modelDriftText(drift: ModelDrift): string {
  return plainLine(`record says ${drift.recorded.model} ${drift.recorded.version}, runs ${drift.observed.model} ${drift.observed.version}, awaiting the lead's confirm`);
}

function paths(input: Scope): { dir: string; file: string } {
  const part = relative(input.root, input.dir);
  if (isAbsolute(part) || part.split(sep).includes('..') || !recordNameOk(input.session) || !recordNameOk(input.seat)) {
    throw new Error('the model-drift report is outside this recipient scope');
  }
  const dir = join(input.dir, 'model-drift', input.session);
  return { dir, file: join(dir, `${input.seat}.json`) };
}

function pair(raw: unknown): raw is Running {
  return raw !== null && typeof raw === 'object' && typeof (raw as Running).model === 'string' && typeof (raw as Running).version === 'string';
}

function readEpisode(file: string, root: string): Episode | null {
  const text = readStateFile(file, undefined, root);
  if (text === null) return null;
  const value = JSON.parse(text) as Episode;
  if (!value || typeof value.id !== 'string' || !PENDING_ID.test(value.id) || typeof value.at !== 'string'
    || !Number.isFinite(Date.parse(value.at)) || typeof value.lead !== 'string' || (value.leadId !== null && typeof value.leadId !== 'string') || typeof value.recipient !== 'string'
    || !pair(value.recorded) || !pair(value.observed) || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !['sending', 'recorded', 'failed', 'uncertain'].includes(value.state) || typeof value.detail !== 'string') {
    throw new Error('the model-drift episode cannot be read');
  }
  return value;
}

function sameEpisode(episode: Episode, drift: ModelDrift, lead: string, leadId: string | null): boolean {
  return episode.recipient === drift.recipient && episode.lead === lead && episode.leadId === leadId
    && !modelDiffers(episode.recorded, drift.recorded) && !modelDiffers(episode.observed, drift.observed);
}

/** Reserve durably before any notice attempt. The callback MUST use ordinary sender admission;
 * there is no runtime inbox writer or admission fallback here. Only a proved pre-admission
 * refusal is retried. An interrupted or uncertain attempt is visible and never auto-replayed. */
export async function reportModelDrift(input: Scope & {
  drift: ModelDrift; lead: string; leadId: string | null; now: Date;
  send(notice: { id: string; at: string; body: string }): Promise<{ ok: boolean; detail: string; retry?: boolean }>;
}): Promise<string> {
  let claim: { episode: Episode; folder: ReturnType<typeof paths> } | { current: string };
  try {
    const folder = paths(input);
    const problem = ensureFoldersBelow(input.root, [relative(input.root, folder.dir)]);
    if (problem !== null) return `lead notice not recorded (${problem})`;
    // The existing metadata lock is released before the ordinary notice send is awaited.
    claim = withLock(folder.dir, (): { episode: Episode; folder: typeof folder } | { current: string } => {
      const previous = readEpisode(folder.file, input.root);
      let episode: Episode;
      if (previous !== null && sameEpisode(previous, input.drift, input.lead, input.leadId)) {
        if (previous.state === 'recorded' || previous.state === 'uncertain') return { current: previous.detail };
        if (previous.state === 'sending') {
          if (pidAlive(previous.pid)) return { current: 'lead notice in progress' };
          const detail = 'lead notice outcome unknown; the interrupted attempt is not replayed';
          writeStateFile(folder.file, `${JSON.stringify({ ...previous, state: 'uncertain', detail })}\n`, { root: input.root });
          return { current: detail };
        }
        episode = { ...previous, state: 'sending', pid: process.pid };
      } else {
        episode = { ...input.drift, id: randomUUID(), at: input.now.toISOString(), lead: input.lead, leadId: input.leadId,
          state: 'sending', pid: process.pid, detail: 'lead notice pending' };
      }
      writeStateFile(folder.file, `${JSON.stringify(episode)}\n`, { root: input.root });
      return { episode, folder };
    });
  } catch {
    return 'lead notice not recorded (the drift episode is unreadable or busy)';
  }
  if ('current' in claim) return claim.current;
  const { episode, folder } = claim;
  let result: { ok: boolean; detail: string; retry?: boolean };
  try {
    result = input.lead === '' ? { ok: false, detail: 'lead notice refused (no lead declared)' }
      : await input.send({ id: episode.id, at: episode.at,
        body: `${input.seat}: ${modelDriftText(input.drift)}. Model-only drift does not stop admitted message delivery; the registry was not changed.` });
  } catch {
    result = { ok: false, detail: 'lead notice not delivered (ordinary send failed)' };
  }
  result.detail = plainLine(result.detail);
  try {
    withLock(folder.dir, () => {
      const held = readEpisode(folder.file, input.root);
      if (held?.id !== episode.id) return;
      writeStateFile(folder.file, `${JSON.stringify({ ...held, state: result.ok ? 'recorded' : result.retry === true ? 'failed' : 'uncertain', detail: result.detail })}\n`, { root: input.root });
    });
  } catch {
    return `${result.detail}; drift episode completion not recorded`;
  }
  return result.detail;
}

/** A positive repaired observation ends an episode; an unread screen does not. */
export function clearModelDrift(input: Scope & { recipient: string }): void {
  try {
    const folder = paths(input);
    if (readEpisode(folder.file, input.root)?.recipient !== input.recipient) return;
    withLock(folder.dir, () => {
      if (readEpisode(folder.file, input.root)?.recipient === input.recipient) unlinkSync(folder.file);
    });
  } catch { /* An unreadable or busy report stays visible; never guess that repair occurred. */ }
}

type ModelContext = { home: string; root: string; session: string; team: TeamFile; live: Live };

function liveModels(input: ModelContext): Array<{ seat: Seat; record: Agent; observed: Running }> {
  const models: Array<{ seat: Seat; record: Agent; observed: Running }> = [];
  if (!input.live.running) return models;
  for (const seat of input.team.seats) {
    const record = findAgent(input.home, { team: teamIdOf(input.root), seat: seat.name });
    const agents = input.live.agents.filter((agent) => agent.name === seat.name);
    const pane = agents.length === 1 ? agents[0]?.pane : undefined;
    if (record === null || record.lifecycle !== 'running' || pane === undefined
      || record.reach.session !== input.session || record.reach.pane !== pane
      || paneHoldsOnlyShell(input.live.processes?.[pane])) continue;
    const observed = signedSeatModel({ cli: record.cli, model: record.signing.model, version: record.signing.version, launch: record.launch }, input.live.screens[pane]);
    if (observed !== null) models.push({ seat, record, observed });
  }
  return models;
}

/** A normal watch pass ends episodes on positive repair even when nobody sends meanwhile. */
export function clearRepairedModelDrifts(input: ModelContext & { dir: string }): void {
  for (const { seat, record, observed } of liveModels(input)) {
    if (!modelDiffers(observed, record.signing)) clearModelDrift({ ...input, seat: seat.name, recipient: record.id });
  }
}

/** Status reads live metadata without changing the registry or the episode file. */
export function modelDriftNotes(input: ModelContext & { dir: string }): string[] {
  const notes: string[] = [];
  const rule = readEntityModelRule(input.home, input.team);
  for (const { seat, record, observed } of liveModels(input)) {
    if (!modelDiffers(observed, record.signing)) continue;
    const refusal = observedModelRefusal(seat, observed, rule);
    const drift = { recipient: record.id, recorded: record.signing, observed };
    let notice = '';
    try {
      const held = readEpisode(paths({ ...input, seat: seat.name }).file, input.root);
      const lead = input.team.orchestrator || input.team.operator;
      const leadId = findAgent(input.home, { team: teamIdOf(input.root), seat: lead })?.id ?? null;
      if (held !== null && sameEpisode(held, drift, lead, leadId)) {
        notice = held.state === 'sending' && !pidAlive(held.pid)
          ? '; lead notice outcome unknown; interrupted attempt not replayed'
          : `; ${held.detail}`;
      }
    } catch { /* The live discrepancy remains visible even without readable episode metadata. */ }
    notes.push(plainLine(`${seat.name}: ${modelDriftText(drift)}${refusal === null ? '' : `; delivery refused: ${refusal}`}${notice}`));
  }
  return notes;
}
