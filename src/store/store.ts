import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Fingerprints } from '../approve/fingerprint.ts';
import { canonicalRecord, teamRecordOf } from '../file/canonical-record.ts';
import { validateTeamFile } from '../file/validate.ts';
import { parseYaml } from '../yaml.ts';
import { bumpGeneration, keyOf, keyState, recordedGeneration, SAFE_GENERATION, signDomain, verifyDomain, verifyPayload, type Json } from './keys.ts';

/**
 * The user-level store: what must survive the project folder and stay out of
 * every seat's working folders. One folder per project root, so a project
 * that is moved or renamed is approved again.
 *
 * A record is signed (format 2): the approval, the stored copy of the file, the
 * project root and a per-project generation, in one canonical encoding. Every
 * reader goes through `approvalStanding`, which verifies the whole record once
 * and hands back an immutable snapshot; a record that does not verify is not an
 * approval, and the standing says which case it is. The key and the generations
 * live outside the store, in a folder of their own (see keys.ts).
 */

export interface Ceilings {
  seats: number;
  temporary: number;
  vendors: Record<string, number>;
}

export interface Approval {
  format: 1 | 2;
  approvedAt: string;
  /** The project root the approval is for. */
  root: string;
  fingerprints: Fingerprints;
  /** Fixed here, and never recomputed from the roster. */
  ceilings: Ceilings;
  /** Each account's check command, resolved and hashed. Absent on an older record. */
  checks?: Record<string, { command: string; path: string; hash: string }>;
  /**
   * The override file as approved, or null when the owner approved there being
   * none. Absent on a record written before the file existed.
   */
  overrides?: string | null;
  /**
   * The approved delegate pane that submitted this approval, when one did. Inside the signed
   * bytes (`payloadOf` covers it): the approving word is the owner's — the signature — and the
   * submission is the pane's. Absent on the owner's own approvals.
   */
  actor?: string;
}

export interface LedgerEntry {
  display: string;
  role: string;
  model: string;
  version: string;
}

const APPROVAL = 'approval.json';
const APPROVED_FILE = 'approved.yaml';
const LEDGER = 'ledger.json';

function rootHash(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that doesn't exist yet keeps its path as given.
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/** The folder every store lives in. Exported so the machine-scope reader (`usage`) can walk it. */
export function storesFolder(home: string): string {
  return join(home, '.config', 'team');
}

/** The store's folder for a project: `<home>/.config/team/<project>-<hash of the root's path>`. */
export function storePath(project: string, root: string, home: string = homedir()): string {
  const name = project.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(storesFolder(home), `${name}-${rootHash(root)}`);
}

/**
 * The store of the project at this root. The current project is the `project:`
 * of `.agents/team.yaml` when that file is real; a link is not followed. That
 * project's folder is the store when it holds an approval. Another folder for
 * the same root is never read in its place: `otherMatchingStores` names it, and
 * nothing deletes it. When the current project has no approval and exactly one
 * folder for this root does, that folder is the store — a rename that has not
 * been approved again leaves the approval in force. Several approvals, and none
 * of them the current project's, is no store: nothing is guessed. Null when
 * this root has no approval on this machine.
 */
export function findStore(root: string, home: string = homedir()): string | null {
  return locateStores(root, home).store;
}

/** Folder names of approvals for this root that `findStore` does not read. Named, never deleted. */
export function otherMatchingStores(root: string, home: string = homedir()): string[] {
  return locateStores(root, home).others;
}

/** The sentence `approve` and `doctor` print for one other store. The name is the folder's own. */
export function otherStoreNote(name: string): string {
  return `another approval store matches this project root and was left in place: ${name}`;
}

/** The current project's name, from a real team file. A link is not a project. */
function projectAt(root: string): string | null {
  const agents = join(root, '.agents');
  try {
    const stat = lstatSync(agents);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const file = join(agents, 'team.yaml');
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
  } catch {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const node = parseYaml(text);
    if (node.kind !== 'map') return null;
    const entry = node.entries.find((item) => item.key === 'project');
    if (!entry || entry.value.kind !== 'scalar' || typeof entry.value.value !== 'string' || entry.value.value === '') return null;
    return entry.value.value;
  } catch {
    return null;
  }
}

function matchingNames(root: string, home: string): string[] | null {
  const suffix = `-${rootHash(root)}`;
  let names: string[];
  try {
    names = readdirSync(storesFolder(home));
  } catch {
    return null;
  }
  return names.filter((candidate) => candidate.endsWith(suffix)).sort();
}

function locateStores(root: string, home: string): { store: string | null; others: string[] } {
  const names = matchingNames(root, home);
  if (names === null || names.length === 0) return { store: null, others: [] };
  const folder = storesFolder(home);
  const project = projectAt(root);
  const expected = project === null ? null : basename(storePath(project, root, home));
  const approved = names.filter((name) => existsSync(join(folder, name, APPROVAL)));
  if (expected !== null && approved.includes(expected)) {
    return { store: join(folder, expected), others: approved.filter((name) => name !== expected) };
  }
  // One approval, under the previous name or with no team file to name a current
  // project: it is the store. A folder that only holds a ledger is not one.
  if (approved.length === 1) {
    const only = approved[0] as string;
    return { store: join(folder, only), others: [] };
  }
  if (approved.length > 1) return { store: null, others: approved };
  if (names.length === 1) {
    const only = names[0] as string;
    return { store: join(folder, only), others: [] };
  }
  return { store: null, others: [] };
}

/** The repair every refused record names, and the one a legacy record names. */
export const LEGACY_LINE = 'approved before records were signed';

/**
 * What the approval store says about a root, verified. The one snapshot every
 * reader uses: `verified` carries a record no caller can change, `legacy` is a
 * record written before records were signed (not trusted, still displayed), and
 * `refused` says which case — each with the one-step repair. `none` is an
 * approval store with nothing in it for this root.
 */
export type Standing =
  | { kind: 'none' }
  | { kind: 'legacy' }
  | { kind: 'refused'; why: string }
  | { kind: 'verified'; record: ApprovalRecord; generation: number; signedAt: string; signedOver?: SignedOver };

/**
 * What the record's signature covers. `record`: the canonical team record
 * (`team-record-c14n-v1`), the form every approval this version writes is signed over.
 * Optional only so a hand-built standing need not name it; `approvalStanding` always does.
 * `text`: the stored file text, the form approvals written before the canonical record were
 * signed over; still verified (same key, its own domain), never written again.
 */
export type SignedOver = 'record' | 'text';

/** The domain of a signature over the canonical team record. `team-approval-v1` stays the text form's. */
export const RECORD_DOMAIN = 'team-approval-v2\n';

/**
 * The canonical team record of a stored copy's text, or null when the text does not validate
 * or has no canonical form. The signature covers this, so a stored copy whose keys were
 * reordered or reformatted still verifies, and a copy whose meaning changed does not.
 */
export function approvedRecordOf(file: string): string | null {
  try {
    const checked = validateTeamFile(file);
    if (!checked.ok) return null;
    return canonicalRecord(teamRecordOf(checked.team as unknown as Record<string, unknown> & { seats: object[] }));
  } catch {
    return null;
  }
}

/** The bytes a record-form signature covers: `payloadOf` with the canonical record in place of the text. */
export function recordPayloadOf(approval: Approval, record: string, generation: number): Json {
  const { file: _text, ...rest } = payloadOf(approval, '', generation) as { [key: string]: Json };
  return { ...rest, record };
}

function sameRoot(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(a) === real(b);
}

/**
 * The bytes a signature covers: the approval (its `format` included, so the
 * stored format cannot be flipped outside the signature), the stored copy, the
 * root inside the approval, and the generation. The delegate's `actor`, when
 * the record names one, is in here too: the submission is signed beside the
 * approving word, and a record whose actor was changed after approval refuses.
 */
export function payloadOf(approval: Approval, file: string, generation: number): Json {
  return {
    approval: {
      format: approval.format,
      approvedAt: approval.approvedAt,
      root: approval.root,
      fingerprints: { sections: approval.fingerprints.sections, seats: approval.fingerprints.seats },
      ceilings: { seats: approval.ceilings.seats, temporary: approval.ceilings.temporary, vendors: approval.ceilings.vendors },
      checks: approval.checks ?? null,
      overrides: approval.overrides ?? null,
      ...(approval.actor !== undefined ? { actor: approval.actor } : {}),
    },
    file,
    generation,
  };
}

/**
 * The standing of this root's approval, from one verified read. A reader never
 * parses the store itself: this is the only way in, and it returns the record
 * only when the whole of it — approval, stored copy, root and generation —
 * carries a signature of this machine's key.
 */
export function approvalStanding(root: string, home: string = homedir()): Standing {
  const store = findStore(root, home);
  if (store === null) return { kind: 'none' };
  let record: ApprovalRecord | null;
  try {
    record = readApproval(store);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    return { kind: 'refused', why: `the approval record cannot be read${detail}` };
  }
  if (record === null) return { kind: 'none' };
  if (record.approval.format === 1) return { kind: 'legacy' };
  const { generation, signature } = record;
  // `shapeProblem` guarantees both on a format-2 record; the check below only
  // narrows the type to what it already proved.
  if (generation === undefined || signature === undefined) {
    return { kind: 'refused', why: 'the record is not in the signed form this version writes' };
  }
  const key = keyState(home);
  if (key.kind === 'missing') {
    return { kind: 'refused', why: 'the record is signed, but its key is missing' };
  }
  if (key.kind === 'unreadable') {
    return { kind: 'refused', why: `${key.why} — no record verifies until it is back` };
  }
  let valid: boolean;
  let signedOver: SignedOver = 'record';
  try {
    // The canonical record first: what this version signs. The stored text must still parse to
    // the record that was signed; a copy that does not validate verifies as nothing here.
    const canonical = approvedRecordOf(record.file);
    valid = canonical !== null && verifyDomain(RECORD_DOMAIN, recordPayloadOf(record.approval, canonical, generation), signature, key.key);
    if (!valid) {
      // Compatibility: a record signed over the file text before the canonical record existed.
      // Same key, its own domain; anything else still refuses.
      valid = verifyPayload(payloadOf(record.approval, record.file, generation), signature, key.key);
      signedOver = 'text';
    }
  } catch {
    // Belt and braces: the shape check below already refuses what the canonical
    // encoder refuses (a signed number outside the safe range), and this catch
    // turns that from an invariant into a promise — no record on disk, however
    // shaped, makes a reader throw.
    return { kind: 'refused', why: 'the record cannot be verified' };
  }
  if (!valid) {
    return { kind: 'refused', why: 'the record does not carry a valid signature: it was changed after approval, or written without the key' };
  }
  if (!sameRoot(record.approval.root, root)) {
    return { kind: 'refused', why: `the record approves another project root (${record.approval.root})` };
  }
  const recorded = recordedGeneration(root, home);
  if (recorded === null) {
    return { kind: 'refused', why: 'no generation is recorded for this project' };
  }
  if (generation !== recorded.generation) {
    return generation < recorded.generation
      ? { kind: 'refused', why: `the record is approval #${generation} but #${recorded.generation} is recorded: an approval was interrupted or an older record was replayed` }
      : { kind: 'refused', why: `the record is approval #${generation} but only #${recorded.generation} is recorded: the key folder was rolled back` };
  }
  return { kind: 'verified', record: frozen(record), generation, signedAt: recorded.at, signedOver };
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

/** The text of the file as the owner last approved it for this root, or null: this copy is verified. */
export function approvedCopy(root: string, home: string = homedir()): string | null {
  const standing = approvalStanding(root, home);
  return standing.kind === 'verified' ? standing.record.file : null;
}

function readJson<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Writes to a temporary file, then renames it: a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export interface ApprovalRecord {
  approval: Approval;
  /** The text of the file as it was approved. */
  file: string;
  /** The signing's number for this project. On a signed record only. */
  generation?: number;
  /** The signature over the canonical payload. On a signed record only. */
  signature?: string;
}

/**
 * A number this version signs must be a counting number inside the canonical
 * encoder's safe range, or the encoder's own refusal would escape the reader:
 * the shape check names the field instead, so the record is `refused`, never a
 * throw. Negative zero passes JavaScript's `>= 0` (and `JSON.stringify` would
 * write it out as plain `0`), so it is named on its own.
 */
function countProblem(value: unknown, field: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return `"${field}" is not a non-negative integer`;
  if (Object.is(value, -0)) return `"${field}" is negative zero`;
  if (value > SAFE_GENERATION) return `"${field}" is beyond the safe integer range`;
  return null;
}

/**
 * The record's shape, checked whole before anything is built from it: nothing
 * outside the signed bytes may carry meaning, so a field this version does not
 * know is a problem naming the field, and a missing or wrongly-typed field is
 * a problem naming the path. Null when the shape is exactly what this version
 * writes — a legacy record included, which is the same shape minus the
 * signature and the generation, and a delegated approval is the signed shape
 * plus the actor that submitted it.
 */
export function shapeProblem(record: unknown): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'the record is not an object';
  const flat = record as Record<string, unknown>;
  if (flat.format !== 1 && flat.format !== 2) return `"format" is neither 1 nor 2`;
  if (flat.format === 1 && (flat.signature !== undefined || flat.generation !== undefined)) {
    return 'the record says format 1 but carries a signature';
  }
  const allowed = ['format', 'approvedAt', 'root', 'fingerprints', 'ceilings', 'file', 'checks', 'overrides'];
  if (flat.format === 2) allowed.push('generation', 'signature', 'actor');
  for (const key of Object.keys(flat)) {
    if (!allowed.includes(key)) return `the record carries a field this version does not know ("${key}")`;
  }
  const missing = ['approvedAt', 'root', 'fingerprints', 'ceilings', 'file'].find((key) => flat[key] === undefined);
  if (missing !== undefined) return `the record has no "${missing}"`;
  for (const key of ['approvedAt', 'root', 'file']) {
    if (typeof flat[key] !== 'string') return `"${key}" is not a string`;
  }
  if (flat.format === 2) {
    if (flat.generation === undefined) return 'the record has no "generation"';
    if (typeof flat.generation !== 'number' || !Number.isInteger(flat.generation) || flat.generation < 1) return `"generation" is not a positive integer`;
    if (flat.generation > SAFE_GENERATION) return '"generation" is beyond the safe integer range';
    if (flat.signature === undefined) return 'the record has no "signature"';
    if (typeof flat.signature !== 'string') return '"signature" is not a string';
    if (flat.actor !== undefined && typeof flat.actor !== 'string') return '"actor" is not a string';
  }
  for (const key of ['fingerprints', 'ceilings']) {
    if (flat[key] === null || typeof flat[key] !== 'object' || Array.isArray(flat[key])) return `"${key}" is not an object`;
  }
  const fingerprints = flat.fingerprints as Record<string, unknown>;
  for (const key of Object.keys(fingerprints)) {
    if (!['sections', 'seats'].includes(key)) return `the record carries a field this version does not know ("fingerprints.${key}")`;
  }
  for (const key of ['sections', 'seats']) {
    if (fingerprints[key] === undefined) return `"fingerprints" has no "${key}"`;
    const map = fingerprints[key];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return `"fingerprints.${key}" is not an object`;
    for (const [name, hash] of Object.entries(map as Record<string, unknown>)) {
      if (typeof hash !== 'string') return `"fingerprints.${key}.${name}" is not a string`;
    }
  }
  const ceilings = flat.ceilings as Record<string, unknown>;
  for (const key of Object.keys(ceilings)) {
    if (!['seats', 'temporary', 'vendors'].includes(key)) return `the record carries a field this version does not know ("ceilings.${key}")`;
  }
  for (const key of ['seats', 'temporary', 'vendors']) {
    if (ceilings[key] === undefined) return `"ceilings" has no "${key}"`;
  }
  for (const key of ['seats', 'temporary']) {
    const problem = countProblem(ceilings[key], `ceilings.${key}`);
    if (problem !== null) return problem;
  }
  if (ceilings.vendors === null || typeof ceilings.vendors !== 'object' || Array.isArray(ceilings.vendors)) return '"ceilings.vendors" is not an object';
  for (const [vendor, seats] of Object.entries(ceilings.vendors as Record<string, unknown>)) {
    const problem = countProblem(seats, `ceilings.vendors.${vendor}`);
    if (problem !== null) return problem;
  }
  if (flat.checks !== undefined) {
    if (flat.checks === null || typeof flat.checks !== 'object' || Array.isArray(flat.checks)) return '"checks" is not an object';
    for (const [account, check] of Object.entries(flat.checks as Record<string, unknown>)) {
      if (check === null || typeof check !== 'object' || Array.isArray(check)) return `"checks.${account}" is not an object`;
      const fields = check as Record<string, unknown>;
      for (const key of ['command', 'path', 'hash']) {
        if (fields[key] === undefined) return `"checks.${account}" has no "${key}"`;
        if (typeof fields[key] !== 'string') return `"checks.${account}.${key}" is not a string`;
      }
      for (const key of Object.keys(fields)) {
        if (!['command', 'path', 'hash'].includes(key)) return `the record carries a field this version does not know ("checks.${account}.${key}")`;
      }
    }
  }
  if (flat.overrides !== undefined && flat.overrides !== null && typeof flat.overrides !== 'string') return '"overrides" is not a string or null';
  return null;
}

/**
 * The approval for this project as the store holds it, parsed without judging
 * it: legacy records read here too, so `approve` can diff against what is on
 * disk. Anything malformed throws, so no caller ever builds on half a record;
 * trusting what reads clean is `approvalStanding`'s to decide, never a caller's.
 */
export function readApproval(store: string): ApprovalRecord | null {
  const stored = readJson<Record<string, unknown>>(join(store, APPROVAL));
  if (stored === null) return null;
  const problem = shapeProblem(stored);
  if (problem !== null) throw new Error(`${join(store, APPROVAL)}: ${problem}`);
  const { file, generation, signature, ...approval } = stored as unknown as Approval & { file: string; generation?: number; signature?: string };
  return {
    approval,
    file,
    ...(generation !== undefined ? { generation } : {}),
    ...(signature !== undefined ? { signature } : {}),
  };
}

/** The ledger: every `display` and `role` the team has had. */
export function readLedger(store: string): LedgerEntry[] {
  return readJson<LedgerEntry[]>(join(store, LEDGER)) ?? [];
}

function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  return a.display === b.display && a.role === b.role && a.model === b.model && a.version === b.version;
}

/** The ledger with these seats added; entries are never removed. */
export function mergeLedger(ledger: readonly LedgerEntry[], seats: readonly LedgerEntry[]): LedgerEntry[] {
  const merged = [...ledger];
  for (const seat of seats) {
    const entry = { display: seat.display, role: seat.role, model: seat.model, version: seat.version };
    if (!merged.some((known) => sameEntry(known, entry))) merged.push(entry);
  }
  return merged;
}

/**
 * Records an approval, signed. The generation of this project moves first —
 * atomically, in the key folder — then the whole record (approval, stored copy,
 * root and generation) is signed with the owner's key and written in one atomic
 * write, so a write that stops halfway leaves the earlier approval stale, which
 * every reader refuses with the repair rather than trusting half a record.
 * `approved.yaml` stays a copy for the owner to read, never read back. Every
 * signing `team` itself performs moves the generation — an amendment by `add`
 * or `remove --keep` is a signing too. A process that holds the key could
 * re-sign at the same generation instead; the counter is evidence of what
 * `team` wrote, never of every signing that ever happened.
 */
export function writeApproval(
  store: string,
  record: ApprovalRecord,
  seats: readonly LedgerEntry[],
  home: string = homedir(),
  now: Date = new Date(),
): number {
  const key = keyOf(home);
  // Signed over the canonical team record, never the text: a file whose keys are reordered
  // signs the same bytes. A text with no canonical record is not signed at all.
  const canonical = approvedRecordOf(record.file);
  if (canonical === null) throw new Error('the copy to approve is not a team record; nothing signed');
  const generation = bumpGeneration(record.approval.root, home, now);
  const signature = signDomain(RECORD_DOMAIN, recordPayloadOf(record.approval, canonical, generation), key);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
  writeAtomic(join(store, APPROVAL), `${JSON.stringify({ ...record.approval, file: record.file, generation, signature }, null, 2)}\n`);
  writeAtomic(join(store, APPROVED_FILE), record.file);
  return generation;
}

/** Adds seats the team has had. The approval itself is left as it is. */
export function recordLedger(store: string, seats: readonly LedgerEntry[]): void {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
}
