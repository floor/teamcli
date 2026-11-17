// Source: lead decision 2026-11-11 02:30Z, following the cross-lab model-follows-cli read:
// model-only drift delivers and flags; an observation never relaxes the entity model rule.
import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from '../host/guarded-fs.ts';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readStateFile, writeStateFile } from '../file-write.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { plainLine } from '../launch/plain.ts';
import { readEntityModelRule, type EntityModelRule } from '../policy/entity-rule.ts';
import { readPolicyChain } from '../policy/sources.ts';
import { resolvePolicyChain } from '../policy/resolve.ts';
import { labOfModel, modelRuleAllows, modelRuleEntryFor, modelRuleSentence, modelRuleUnknownSentence } from '../policy/model-rule.ts';
import { agentsDir, findAgent, type Agent } from '../registry/agents.ts';
import { paneHoldsOnlyShell } from '../launch/identity.ts';
import { teamIdOf } from '../registry/teams.ts';
import { pidAlive, withLock } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { modelDiffers, positiveModelObservation, signedSeatModelObservation, type Running, type SeatModelObservation } from '../status/statusline.ts';
import { ensureFoldersBelow } from './history.ts';
import { PENDING_ID } from './pending.ts';
import { recordNameOk } from './record.ts';

export type ModelDrift = { recipient: string; recorded: Running; observed: Running };
type Scope = { dir: string; root: string; session: string; seat: string };
type Episode = ModelDrift & { id: string; generation: string; at: string; lead: string; leadId: string | null; state: 'sending' | 'recorded' | 'failed' | 'uncertain'; pid: number; detail: string };

/** The proposed observation is judged as a model, never as the file's old vendor word. */
export type ModelDriftMode = 'rule' | 'deliver' | 'hold';

/** The `model-drift` policy for the receiving team (entity, project, team levels), `deliver` when
 *  the chain cannot be read or names none: a seat whose model changed on purpose (the owner's
 *  `/model`) must stay reachable while its lead repairs the record (2026-11-13). */
export function modelDriftMode(home: string, root: string, team: TeamFile): ModelDriftMode {
  try {
    const chain = resolvePolicyChain(readPolicyChain({ home, teamRoot: root, team }), { upToLevel: 'team' });
    const value = chain.ok ? chain.policies['model-drift']?.value : undefined;
    return value === 'rule' || value === 'hold' ? value : 'deliver';
  } catch {
    return 'deliver';
  }
}

/** Why a drifted send is refused under the policy, or null when it may go on (with its drift
 *  notice). `hold` refuses every drift; `rule` lets it through only when the entity's model rule
 *  names this seat and allows the observed lab — a missing rule or a seat the rule does not name
 *  is no permission (review finding 3); `deliver` lets every drift through. */
export function driftRefusal(mode: ModelDriftMode, seat: { name: string; role: string }, observed: Running, rule: EntityModelRule): string | null {
  if (mode === 'deliver') return null;
  if (mode === 'hold') return 'the model-drift policy holds every drift until the seat is repaired';
  if (rule.kind !== 'rule') return 'no entity model rule allows this model for the seat';
  if (modelRuleEntryFor(rule.entries, seat) === undefined) return 'the entity model rule names no entry for this seat';
  const lab = labOfModel(observed.model);
  if (lab === undefined || !modelRuleAllows(rule.entries, { ...seat, vendor: lab })) return 'the entity model rule does not allow this model for the seat';
  return null;
}

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
  if (!value || typeof value.id !== 'string' || !PENDING_ID.test(value.id) || typeof value.generation !== 'string' || !PENDING_ID.test(value.generation) || typeof value.at !== 'string'
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
      let previous = readEpisode(folder.file, input.root);
      let episode: Episode;
      if (previous !== null && sameEpisode(previous, input.drift, input.lead, input.leadId)) {
        // Each fresh drift observation invalidates any older matching watch snapshot, even
        // when the drift tuple and the notice id stay the same. No clock ordering is assumed.
        previous = { ...previous, generation: randomUUID() };
        writeStateFile(folder.file, `${JSON.stringify(previous)}\n`, { root: input.root });
        if (previous.state === 'recorded' || previous.state === 'uncertain') return { current: previous.detail };
        if (previous.state === 'sending') {
          if (pidAlive(previous.pid)) return { current: 'lead notice in progress' };
          const detail = 'lead notice outcome unknown; the interrupted attempt is not replayed';
          writeStateFile(folder.file, `${JSON.stringify({ ...previous, state: 'uncertain', detail })}\n`, { root: input.root });
          return { current: detail };
        }
        episode = { ...previous, state: 'sending', pid: process.pid };
      } else {
        episode = { ...input.drift, id: randomUUID(), generation: randomUUID(), at: input.now.toISOString(), lead: input.lead, leadId: input.leadId,
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

/** A clear is bound to the episode and registry binding captured BEFORE the observation. */
export type ModelDriftFence = { episodeId: string; generation: string; recipient: string; binding: string };

function recipientBinding(record: Agent): string {
  return JSON.stringify({ id: record.id, reach: record.reach, cli: record.cli, signing: record.signing,
    launch: createHash('sha256').update(record.launch).digest('hex'),
    updatedAt: record.provenance.updated_at, seq: record.provenance.seq ?? null });
}

export function captureModelDriftFence(input: Scope & { home: string }, supplied?: Agent): ModelDriftFence | null {
  try {
    const held = readEpisode(paths(input).file, input.root);
    const record = supplied ?? findAgent(input.home, { team: teamIdOf(input.root), seat: input.seat }, { fresh: true });
    if (held === null || record === null || held.recipient !== record.id
      || record.reach.team !== teamIdOf(input.root) || record.reach.seat !== input.seat
      || record.reach.session !== input.session) return null;
    return { episodeId: held.id, generation: held.generation, recipient: record.id, binding: recipientBinding(record) };
  } catch { return null; }
}

export function captureModelDriftFences(input: { dir: string; root: string; home: string; session: string; team: TeamFile }): ReadonlyMap<string, ModelDriftFence> {
  const captured = new Map<string, ModelDriftFence>();
  for (const seat of input.team.seats) {
    const fence = captureModelDriftFence({ ...input, seat: seat.name });
    if (fence !== null) captured.set(seat.name, fence);
  }
  return captured;
}

/** Declaration-only and unread readings cannot clear. The locked compare prevents a stale
 * observation from removing a newer episode, newer drift observation, or changed binding. */
export function clearModelDrift(input: Scope & {
  home: string; recipient: string; observation: SeatModelObservation; fence: ModelDriftFence | null;
}): void {
  if (input.fence === null || !positiveModelObservation(input.observation)) return;
  const fence = input.fence;
  const observed = input.observation.model;
  try {
    const folder = paths(input);
    // Registry -> episode, matching the registry -> state order used by registry writers.
    // The unlink is the commit point: no normal registry writer may publish a new binding
    // between this fresh comparison and deletion (lead R3 decision, 2026-11-11 05:12Z).
    withLock(agentsDir(input.home), () => withLock(folder.dir, () => {
      const held = readEpisode(folder.file, input.root);
      // A pane read can outlive an external registry write. Revalidate the current winner from
      // files through the existing registry validator, never the send's earlier memo entry.
      const record = findAgent(input.home, { team: teamIdOf(input.root), seat: input.seat }, { fresh: true });
      if (held === null || record === null || record.lifecycle !== 'running'
        || held.id !== fence.episodeId || held.generation !== fence.generation
        || held.recipient !== input.recipient || record.id !== fence.recipient
        || record.id !== input.recipient || recipientBinding(record) !== fence.binding
        || modelDiffers(observed, record.signing)) return;
      unlinkSync(folder.file);
    }));
  } catch { /* An unreadable or busy report stays visible; never guess that repair occurred. */ }
}

type ModelContext = { home: string; root: string; session: string; team: TeamFile; live: Live };

function liveModels(input: ModelContext): Array<{ seat: Seat; record: Agent; observed: Running; observation: SeatModelObservation }> {
  const models: Array<{ seat: Seat; record: Agent; observed: Running; observation: SeatModelObservation }> = [];
  if (!input.live.running) return models;
  for (const seat of input.team.seats) {
    const record = findAgent(input.home, { team: teamIdOf(input.root), seat: seat.name });
    const agents = input.live.agents.filter((agent) => agent.name === seat.name);
    const pane = agents.length === 1 ? agents[0]?.pane : undefined;
    if (record === null || record.lifecycle !== 'running' || pane === undefined
      || record.reach.session !== input.session || record.reach.pane !== pane
      || paneHoldsOnlyShell(input.live.processes?.[pane])) continue;
    const observation = signedSeatModelObservation({ cli: record.cli, model: record.signing.model, version: record.signing.version, launch: record.launch }, input.live.screens[pane]);
    if (observation.model !== null) models.push({ seat, record, observed: observation.model, observation });
  }
  return models;
}

/** A normal watch pass ends episodes on positive repair even when nobody sends meanwhile. */
export function clearRepairedModelDrifts(input: ModelContext & { dir: string; fences: ReadonlyMap<string, ModelDriftFence> }): void {
  for (const { seat, record, observation } of liveModels(input)) {
    clearModelDrift({ ...input, seat: seat.name, recipient: record.id, observation,
      fence: input.fences.get(seat.name) ?? null });
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
