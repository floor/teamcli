// The checks of `team release check`, against the public npm and GitHub records of one release —
// and, when the file configures them, the Linear record (one bounded, read-only GraphQL read
// behind a Keychain-held key that lives in exactly one request header) and the public activity
// marker. Every check reports pass, missing or unknown: missing is a completed, interpretable
// read that disproves the condition; unknown is a failed, incomplete, malformed or unexpected
// read, and unknown is never pass. A compound check makes every required read its known upstream
// results can still form — it does not short-circuit after a missing condition — and combines
// them unknown, then missing, then pass. A read an upstream missing makes unformable is not
// required and is not requested; one an upstream unknown makes unformable is unknown.
//
// Beside the checks, one warning: npm's `next` dist-tag pointing at a version older than
// `latest`. It is a hint, not a check — it carries no status and changes no exit — so the run
// prints it only when it can be evaluated and found wanting (`staleNextWarning`).
import { compareVersions, hasPrerelease } from './grammar.ts';
import type { Attempt, Fetch, RequestOptions } from './http.ts';
import type { KeyReader } from './keychain.ts';
import type { ReleaseDecl } from '../file/sections/releases.ts';

export type Status = 'pass' | 'missing' | 'unknown';
export type Outcome = { status: Status; detail: string };
export type ReleaseResult = {
  npm: Outcome;
  tag: Outcome;
  github: Outcome;
  changelog: Outcome;
  /** Present exactly when npm's `next` dist-tag trails `latest` (`staleNextWarning`). */
  warning?: string;
  /** Present exactly when the file configures the pair. */
  linear?: Outcome;
  activity?: Outcome;
};

/** One command's budget: at most fourteen endpoint reads and twenty-eight HTTP attempts, retries included. */
export const READ_CAP = 14;
export const ATTEMPT_CAP = 28;

export type Caps = { reads: number; attempts: number };

/** What one run is wired with beyond the network: the Keychain reader, and caps for tests. */
export type CheckDeps = { keyReader?: KeyReader; caps?: Caps };

const PROVENANCE = 'https://slsa.dev/provenance/v1';

/** One RFC 3986 path segment or query value: unreserved characters, uppercase %HH for the rest. */
export function encodeSegment(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9._~-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

type Reply =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'over-limit'; status: number; prefix: string }
  | { kind: 'failed' };

// An attempt as the reply a check reads: the whole response, an over-limit response as the decoded
// head of its body (a value a check needs can sit near a document's head, and the compare's
// `status` does), or a failure — a kind with no response, or the attempt cap reached.
function replyOf(attempt: Attempt | null): Reply {
  if (attempt === null) return { kind: 'failed' };
  if (attempt.kind === 'http') return attempt;
  if (attempt.kind === 'too-large') return { kind: 'over-limit', status: attempt.status, prefix: attempt.prefix };
  return { kind: 'failed' };
}

/** The reads of one command, with the retry policy and the two caps. */
export class Reader {
  reads = 0;
  attempts = 0;
  private fetcher: Fetch;
  private caps: Caps;
  constructor(fetcher: Fetch, caps: Caps = { reads: READ_CAP, attempts: ATTEMPT_CAP }) {
    this.fetcher = fetcher;
    this.caps = caps;
  }

  /** Whether one more read could still be made. The budget is a non-secret prerequisite: a
   *  check that reads a secret before its one request must test this first, so a cap that
   *  already prevents the request never causes secret access. */
  canRead(): boolean {
    return this.reads < this.caps.reads && this.attempts < this.caps.attempts;
  }

  /** One endpoint read: an HTTP response, or a failure after its one allowed retry. The Linear
   *  read passes its POST options; a retry replays them byte for byte (it is a read-only query). */
  async read(url: string, request?: RequestOptions): Promise<Reply> {
    // A read that would exceed its cap is not made; the check needing it reads unknown.
    if (this.reads >= this.caps.reads) return { kind: 'failed' };
    this.reads++;
    const first = await this.attempt(url, request);
    if (first === null) return { kind: 'failed' };
    if (!retried(first)) return replyOf(first);
    return replyOf(await this.attempt(url, request));
  }

  private async attempt(url: string, request?: RequestOptions): Promise<Attempt | null> {
    if (this.attempts >= this.caps.attempts) return null;
    this.attempts++;
    return this.fetcher(url, request);
  }
}

// A timeout, a transport failure, or a 408, 429 or 5xx is retried exactly once; nothing else is.
// Every kind that comes from a response carries its status, so the decision reads only that
// status and the two no-response kinds — whatever the body could or could not be decoded into.
export function retried(attempt: Attempt): boolean {
  if (attempt.kind === 'timeout' || attempt.kind === 'transport') return true;
  const { status } = attempt;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

type ReadRecord =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'json'; value: Record<string, unknown> };

// A reply as the record a check reads: a 404 is missing; a success with a JSON object is the
// record; anything else — another status, a redirect, invalid JSON, a failed or capped read, the
// head of an over-limit body, which is a prefix and not a document — is unknown.
function recordOf(reply: Reply): ReadRecord {
  if (reply.kind !== 'http') return { kind: 'unknown' };
  if (reply.status === 404) return { kind: 'missing' };
  if (reply.status < 200 || reply.status > 299) return { kind: 'unknown' };
  const value = jsonObject(reply.body);
  return value ? { kind: 'json', value } : { kind: 'unknown' };
}

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Unknown when any part is unknown, else missing when any is missing, else pass. */
function combine(parts: Outcome[], passDetail: string): Outcome {
  for (const part of parts) if (part.status === 'unknown') return part;
  for (const part of parts) if (part.status === 'missing') return part;
  return { status: 'pass', detail: passDetail };
}

const pass: Outcome = { status: 'pass', detail: '' };

/** The repository read the tag and changelog checks share: the default branch. */
type Repo = { kind: 'missing'; detail: string } | { kind: 'unknown'; detail: string } | { kind: 'ok'; branch: string };

async function readRepo(reader: Reader, base: string, github: string): Promise<Repo> {
  const record = recordOf(await reader.read(base));
  if (record.kind === 'missing') return { kind: 'missing', detail: `GitHub has no repository ${github}` };
  if (record.kind === 'unknown') return { kind: 'unknown', detail: 'the repository could not be read' };
  const branch = record.value.default_branch;
  if (typeof branch !== 'string' || branch === '') return { kind: 'unknown', detail: 'the repository could not be read' };
  return { kind: 'ok', branch };
}

function npmVersionPart(record: ReadRecord, name: string, version: string): Outcome {
  if (record.kind === 'missing') return { status: 'missing', detail: `npm has no ${name}@${version}` };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the npm record could not be read' };
  const value = record.value;
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || value.name !== name || value.version !== version) {
    return { status: 'unknown', detail: 'the npm record is not for this package and version' };
  }
  const dist = value.dist;
  if (dist === undefined) return { status: 'missing', detail: 'the npm record has no dist' };
  if (!isObject(dist)) return { status: 'unknown', detail: "the npm record's dist is not an object" };
  // Every field is examined before deciding: only an absent or empty checksum is missing, a
  // present non-string one is unknown, and unknown beats missing across the two fields.
  const parts: Outcome[] = [];
  for (const key of ['shasum', 'integrity'] as const) {
    const checksum = dist[key];
    if (checksum === undefined) parts.push({ status: 'missing', detail: `the npm record has no dist.${key}` });
    else if (typeof checksum !== 'string') parts.push({ status: 'unknown', detail: `dist.${key} is not a string` });
    else if (checksum === '') parts.push({ status: 'missing', detail: `the npm record has an empty dist.${key}` });
  }
  for (const part of parts) if (part.status === 'unknown') return part;
  if (parts.length > 0) return parts[0] as Outcome;
  return pass;
}

function attestationPart(record: ReadRecord): Outcome {
  if (record.kind === 'missing') return { status: 'missing', detail: 'npm shows no provenance attestation for this version' };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the attestation response could not be read' };
  const list = record.value.attestations;
  if (!Array.isArray(list)) return { status: 'unknown', detail: 'the attestation response has no attestations list' };
  const proven = list.some((entry) => isObject(entry) && entry.predicateType === PROVENANCE);
  return proven ? pass : { status: 'missing', detail: 'npm shows no provenance attestation for this version' };
}

async function npmCheck(reader: Reader, decl: ReleaseDecl, version: string): Promise<Outcome> {
  const record = recordOf(await reader.read(`https://registry.npmjs.org/${encodeSegment(decl.package)}/${encodeSegment(version)}`));
  const parts = [npmVersionPart(record, decl.package, version)];
  if (decl.trustedPublishing) {
    const attested = recordOf(
      await reader.read(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeSegment(`${decl.package}@${version}`)}`),
    );
    parts.push(attestationPart(attested));
  }
  return combine(parts, decl.trustedPublishing ? 'exact version, checksums, and provenance found' : 'exact version and checksums found');
}

/**
 * The one warning beside the checks: npm's `next` dist-tag pointing at a version older than
 * `latest`, which the owner's own `npm dist-tag add` catches up — this run names that command and
 * never runs it. The tags come from npm's small dist-tags endpoint, never the full packument. A
 * warning is not a check: it carries no status, changes no exit, and every state it cannot
 * evaluate prints nothing — a read that failed, answered something unexpected or was refused by
 * the cap; a document missing either tag; a tag that is not a version (`compareVersions`), so
 * nothing here guesses at a tag that is not one — the same silence a package that never had a
 * `next` tag (the common case) gets.
 */
async function staleNextWarning(reader: Reader, name: string): Promise<string | undefined> {
  const record = recordOf(await reader.read(`https://registry.npmjs.org/-/package/${encodeSegment(name)}/dist-tags`));
  if (record.kind !== 'json') return undefined;
  const { next, latest } = record.value;
  if (typeof next !== 'string' || typeof latest !== 'string') return undefined;
  const order = compareVersions(next, latest);
  if (order === null || order >= 0) return undefined;
  return `npm's next dist-tag points at ${next}, older than latest ${latest}: run npm dist-tag add ${name}@${latest} next`;
}

/** A full Git commit SHA: forty lowercase hex characters — what a compare segment is built from. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The `sha` and `type` of a ref or tag object, or null when either is missing or malformed. */
function targetOf(value: Record<string, unknown>): { sha: string; type: string } | null {
  const object = value.object;
  if (!isObject(object) || typeof object.type !== 'string' || typeof object.sha !== 'string' || !SHA_PATTERN.test(object.sha)) {
    return null;
  }
  return { sha: object.sha, type: object.type };
}

/** The compare's `status` as one string, or null for anything unreadable. A compare body that
 *  overran the fetch's limit is kept as its decoded head, and the status sits near that head —
 *  before the commit and file lists, where a large compare's bulk is (measured 2026-10-07:
 *  "status" at byte 14,398 of a 1,161,071-byte compare) — so an over-limit reply is read from
 *  its head rather than failing a valid release check on the size of a diff nobody reads. */
function compareStatus(reply: Reply): string | null {
  if (reply.kind === 'http') {
    if (reply.status < 200 || reply.status > 299) return null;
    const value = jsonObject(reply.body);
    const status = value === null ? undefined : value.status;
    return typeof status === 'string' ? status : null;
  }
  if (reply.kind === 'over-limit' && reply.status >= 200 && reply.status <= 299) return statusInHead(reply.prefix);
  return null;
}

/** The value of the top-level `status` string in the head of a compare document, or null. The
 *  head is a prefix of a JSON object — the limit cut it — so it may end at any byte: this walks
 *  the JSON grammar only as far as one top-level string value, strings with their escapes and
 *  nesting included, and a head that ends first, or holds no top-level `status`, reads as null.
 *  Only the top level counts: a `status` nested in an object — a commit's, say — is skipped with
 *  that value. An escape is read as written, so an escaped key is not `status`, and an escaped
 *  value cannot read as one of the four plain status words. */
function statusInHead(head: string): string | null {
  let i = 0;
  const space = (): void => {
    while (i < head.length && (head[i] === ' ' || head[i] === '\n' || head[i] === '\r' || head[i] === '\t')) i += 1;
  };
  // One past the string starting at i, or null when it never closes; i ends one past it too. A
  // backslash skips the byte after it, so an escaped quote never closes the string.
  const stringEnd = (): number | null => {
    if (head[i] !== '"') return null;
    for (i += 1; i < head.length; i += 1) {
      if (head[i] === '\\') i += 1;
      else if (head[i] === '"') {
        i += 1;
        return i;
      }
    }
    return null;
  };
  // Whether the value starting at i was walked whole; i ends past it.
  const value = (): boolean => {
    const first = head[i];
    if (first === '"') return stringEnd() !== null;
    if (first === '{' || first === '[') {
      const open: string[] = [first];
      i += 1;
      while (i < head.length) {
        const c = head[i] as string;
        if (c === '"') {
          if (stringEnd() === null) return false;
        } else if (c === '{' || c === '[') {
          open.push(c);
          i += 1;
        } else if (c === '}' || c === ']') {
          if ((open.pop() === '{') !== (c === '}')) return false;
          i += 1;
          if (open.length === 0) return true;
        } else {
          i += 1;
        }
      }
      return false;
    }
    // A number or a literal (`true`, `false`, `null`): everything to the first delimiter.
    const start = i;
    while (i < head.length && !',}] \t\r\n'.includes(head[i] as string)) i += 1;
    return i > start;
  };
  space();
  if (head[i] !== '{') return null;
  i += 1;
  for (;;) {
    space();
    const keyStart = i;
    const keyEnd = stringEnd();
    if (keyEnd === null) return null; // '}' read whole: no top-level status
    const key = head.slice(keyStart + 1, keyEnd - 1);
    space();
    if (head[i] !== ':') return null;
    i += 1;
    space();
    const valueStart = i;
    if (key === 'status') {
      const end = stringEnd();
      return end === null ? null : head.slice(valueStart + 1, end - 1);
    }
    if (!value()) return null;
    space();
    if (head[i] !== ',') return null; // '}' or a cut head: no status was read
    i += 1;
  }
}

async function tagCheck(reader: Reader, base: string, version: string, repo: Repo): Promise<Outcome> {
  const parts: Outcome[] = [];
  let commit: string | null = null;
  const ref = recordOf(await reader.read(`${base}/git/ref/tags/v${encodeSegment(version)}`));
  if (ref.kind === 'missing') {
    parts.push({ status: 'missing', detail: `GitHub has no tag v${version}` });
  } else if (ref.kind === 'unknown') {
    parts.push({ status: 'unknown', detail: 'the tag could not be read' });
  } else {
    const first = targetOf(ref.value);
    if (first === null) {
      parts.push({ status: 'unknown', detail: 'the tag could not be read' });
    } else {
      let target = first;
      let hops = 0;
      let broken: Outcome | null = null;
      // An annotated tag resolves through at most four tag objects; a fifth required hop is unknown.
      while (target.type === 'tag' && broken === null) {
        if (hops === 4) {
          broken = { status: 'unknown', detail: 'the tag chain needs a fifth tag object' };
          break;
        }
        hops++;
        const hop = recordOf(await reader.read(`${base}/git/tags/${encodeSegment(target.sha)}`));
        if (hop.kind === 'missing') broken = { status: 'missing', detail: `GitHub has no tag object ${target.sha}` };
        else if (hop.kind === 'unknown') broken = { status: 'unknown', detail: 'a tag object could not be read' };
        else {
          const next = targetOf(hop.value);
          if (next === null) {
            broken = { status: 'unknown', detail: 'a tag object could not be read' };
          } else {
            target = next;
          }
        }
      }
      if (broken !== null) parts.push(broken);
      else if (target.type !== 'commit') parts.push({ status: 'missing', detail: 'the tag does not resolve to a commit' });
      else {
        commit = target.sha;
        parts.push(pass);
      }
    }
  }
  // The compare is required only when both its inputs are known: a resolved commit and the
  // default branch. Otherwise the repository read alone carries its outcome into the check.
  if (commit !== null && repo.kind === 'ok') {
    const reply = await reader.read(`${base}/compare/${encodeSegment(commit)}...${encodeSegment(repo.branch)}`);
    if (reply.kind === 'http' && reply.status === 404) {
      parts.push({ status: 'missing', detail: 'GitHub has no compare of the tag and the default branch' });
    } else {
      const status = compareStatus(reply);
      if (status === 'identical' || status === 'ahead') parts.push(pass);
      else if (status === 'behind' || status === 'diverged') {
        parts.push({ status: 'missing', detail: 'tag commit is not an ancestor of the default branch' });
      } else {
        parts.push({ status: 'unknown', detail: 'the compare could not be read' });
      }
    }
  }
  if (repo.kind !== 'ok') parts.push({ status: repo.kind, detail: repo.detail });
  return combine(parts, 'tag resolves to a commit on the default branch');
}

async function githubCheck(reader: Reader, base: string, version: string): Promise<Outcome> {
  const record = recordOf(await reader.read(`${base}/releases/tags/v${encodeSegment(version)}`));
  if (record.kind === 'missing') return { status: 'missing', detail: `GitHub has no release for v${version}` };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the release could not be read' };
  const { draft, prerelease } = record.value;
  if (typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return { status: 'unknown', detail: 'the release could not be read' };
  if (draft) return { status: 'missing', detail: 'the release is a draft' };
  const wanted = hasPrerelease(version);
  if (prerelease !== wanted) {
    return { status: 'missing', detail: wanted ? 'the release is not marked as a prerelease' : 'the release is marked as a prerelease' };
  }
  return { status: 'pass', detail: 'published release matches SemVer channel' };
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 9999) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/** A GitHub contents object as the checks read it: a base64 `file`, decoded as strict UTF-8. */
function decodeContents(value: Record<string, unknown>): string | null {
  if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') return null;
  const cleaned = value.content.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleaned)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cleaned, 'base64'));
  } catch {
    return null;
  }
}

/** The changelog's outcome, and the release date's instant at exactly 00:00:00Z when it passed. */
export type ChangelogRead = { outcome: Outcome; releaseAt: number | null };

function changelogPart(text: string, version: string): ChangelogRead {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const accepted = new RegExp(`^## (?:\\[${escaped}\\]|${escaped}) - ([0-9]{4})-([0-9]{2})-([0-9]{2})[ \t]*$`);
  const forVersion = new RegExp(`^## (?:\\[${escaped}\\]|${escaped}) - `);
  let named = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const match = accepted.exec(line);
    if (match && validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      const releaseAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return { outcome: { status: 'pass', detail: 'changelog entry has a valid release date' }, releaseAt };
    }
    if (match || forVersion.test(line)) named = true;
  }
  const outcome = named
    ? { status: 'missing' as const, detail: `the changelog entry for ${version} has an invalid date` }
    : { status: 'missing' as const, detail: `CHANGELOG.md has no entry for ${version}` };
  return { outcome, releaseAt: null };
}

async function changelogCheck(reader: Reader, base: string, version: string, repo: Repo): Promise<ChangelogRead> {
  const only = (outcome: Outcome): ChangelogRead => ({ outcome, releaseAt: null });
  if (repo.kind === 'missing') return only({ status: 'missing', detail: repo.detail });
  if (repo.kind === 'unknown') return only({ status: 'unknown', detail: repo.detail });
  const record = recordOf(await reader.read(`${base}/contents/CHANGELOG.md?ref=${encodeSegment(repo.branch)}`));
  if (record.kind === 'missing') return only({ status: 'missing', detail: 'the default branch has no CHANGELOG.md' });
  if (record.kind === 'unknown') return only({ status: 'unknown', detail: 'the changelog could not be read' });
  const text = decodeContents(record.value);
  if (text === null) return only({ status: 'unknown', detail: 'the changelog could not be read' });
  return changelogPart(text, version);
}

/**
 * The checks of one release, in the output's order. The reads are sequential and deterministic:
 * npm (with its attestation when trusted publishing is declared) and its dist-tags for the one
 * warning, the repository the tag, changelog and activity checks share, the tag chain and
 * compare, the release, the changelog, then the Linear and activity reads when their pairs are
 * configured.
 */
export async function runChecks(decl: ReleaseDecl, version: string, fetcher: Fetch, deps: CheckDeps = {}): Promise<ReleaseResult> {
  const reader = new Reader(fetcher, deps.caps);
  const [owner, repoName] = decl.github.split('/') as [string, string];
  const base = `https://api.github.com/repos/${encodeSegment(owner)}/${encodeSegment(repoName)}`;
  const npm = await npmCheck(reader, decl, version);
  const warning = await staleNextWarning(reader, decl.package);
  const repo = await readRepo(reader, base, decl.github);
  const tag = await tagCheck(reader, base, version, repo);
  const github = await githubCheck(reader, base, version);
  const changelog = await changelogCheck(reader, base, version, repo);
  const result: ReleaseResult = { npm, tag, github, changelog: changelog.outcome, ...(warning === undefined ? {} : { warning }) };
  if (decl.linear) result.linear = await linearCheck(reader, decl.linear, version, changelog, deps.keyReader);
  if (decl.activity) result.activity = await activityCheck(reader, base, decl.activity, repo, decl.package, version);
  return result;
}

/* The Linear read: one bounded, read-only GraphQL POST, the key in exactly one header. */

export const LINEAR_URL = 'https://api.linear.app/graphql';

/** The normative GraphQL document: the complete bounded read of one project's first 100
 *  milestones and first 100 project updates, archived records included. Byte for byte the
 *  contract's; no operation, variable or selected datum beyond it. */
export const RELEASE_RECORDS_QUERY = `query ReleaseRecords($projectId: String!, $first: Int!) {
  project(id: $projectId) {
    id
    archivedAt
    projectMilestones(first: $first, includeArchived: true) {
      nodes { name status }
      pageInfo { hasNextPage }
    }
    projectUpdates(first: $first, includeArchived: true) {
      nodes { createdAt archivedAt }
      pageInfo { hasNextPage }
    }
  }
}`;

const LINEAR_UNREAD: Outcome = { status: 'unknown', detail: 'Linear record could not be read' };
const LINEAR_INCOMPLETE: Outcome = { status: 'unknown', detail: 'Linear record is incomplete' };
const KEYCHAIN_UNAVAILABLE: Outcome = { status: 'unknown', detail: 'Keychain access was unavailable' };

// The key may exist only to become the one header: non-empty, ASCII 0x21 through 0x7e (the
// production reader already guarantees it; a stand-in reader is held to the same rule before
// anything is built from its answer).
function legalKey(key: string): boolean {
  if (key.length === 0) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

async function linearCheck(
  reader: Reader,
  config: { project: string; keychainService: string },
  version: string,
  changelog: ChangelogRead,
  keyReader: KeyReader | undefined,
): Promise<Outcome> {
  // The release date gates everything: without it the request cannot be formed, and no key is
  // read — a definitively missing date makes the Linear read not required; an unreadable one
  // makes the check unknown.
  if (changelog.outcome.status === 'unknown') return { status: 'unknown', detail: 'release date could not be read' };
  if (changelog.outcome.status === 'missing') return { status: 'missing', detail: 'release date is missing from changelog' };
  const releaseAt = changelog.releaseAt as number;

  // The non-secret prerequisites come first, in one fixed order: the release date above, then
  // the budget — a cap that already prevents the request must leave the Keychain untouched, and
  // the spec's cap-failure detail is the read that isn't made — and only then the key, the last
  // step before the request itself.
  if (!reader.canRead()) return LINEAR_UNREAD;
  if (keyReader === undefined) return KEYCHAIN_UNAVAILABLE;
  const read = await keyReader(config.keychainService);
  if (!read.ok || !legalKey(read.key)) return KEYCHAIN_UNAVAILABLE;

  // One bounded read: the contract's document and variables, the key in exactly one header, on
  // the Linear host and nowhere else. A retry replays this request byte for byte; a redirect is
  // never followed, so the key can never travel to another host.
  const body = JSON.stringify({ query: RELEASE_RECORDS_QUERY, variables: { projectId: config.project, first: 100 } });
  const reply = await reader.read(LINEAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: read.key },
    body,
  });
  if (reply.kind !== 'http') return LINEAR_UNREAD;
  if (reply.status < 200 || reply.status > 299) return LINEAR_UNREAD;
  const value = jsonObject(reply.body);
  // The response is a JSON object with a data object and no errors key at all; anything else —
  // a GraphQL errors answer (an unknown project id included), a missing data, malformed JSON —
  // is a failed read.
  if (value === null || 'errors' in value || !isObject(value.data)) return LINEAR_UNREAD;
  return linearRecord(value.data, config.project, version, releaseAt);
}

/**
 * The Linear predicate over one well-formed response. Every condition the data can answer is
 * evaluated (no short-circuit); the conditions are collected in the contract's table order, the
 * detail is the first applicable row, and the status follows the usual precedence — unknown,
 * then missing, then pass.
 */
function linearRecord(data: Record<string, unknown>, projectId: string, version: string, releaseAt: number): Outcome {
  const conditions: Outcome[] = [];
  const project = data.project;
  if (!isObject(project) || typeof project.id !== 'string' || project.id !== projectId) {
    conditions.push(LINEAR_INCOMPLETE);
  } else {
    // Two archive states are legal: null, the active project; and a valid timestamp string, the
    // archived project. Any other shape is malformed selected data — unknown, never missing.
    const { archivedAt } = project;
    if (archivedAt === null) {
      // Not archived: no condition.
    } else if (typeof archivedAt === 'string' && timestampOf(archivedAt) !== null) {
      conditions.push({ status: 'missing', detail: 'configured Linear project is archived' });
    } else {
      conditions.push(LINEAR_INCOMPLETE);
    }
    conditions.push(...milestoneConditions(project.projectMilestones, version));
    conditions.push(...updateConditions(project.projectUpdates, releaseAt));
  }
  if (conditions.length === 0) return { status: 'pass', detail: 'Linear milestone is complete and a qualifying status update exists' };
  const detail = (conditions[0] as Outcome).detail;
  for (const condition of conditions) if (condition.status === 'unknown') return { status: 'unknown', detail };
  return { status: 'missing', detail };
}

/** A selected relation's complete bounded read: its nodes and the proof there is no next page. */
function relationNodes(value: unknown): unknown[] | null {
  if (!isObject(value) || !Array.isArray(value.nodes)) return null;
  const pageInfo = value.pageInfo;
  if (!isObject(pageInfo) || pageInfo.hasNextPage !== false) return null;
  return value.nodes;
}

// Every returned milestone participates. Zero matches are missing; exactly one `done` match
// satisfies the condition; one match with another status is missing; two or more are unknown.
// A node without a string name or status makes the count unanswerable, so the record is
// incomplete — no counting row applies.
function milestoneConditions(value: unknown, version: string): Outcome[] {
  const nodes = relationNodes(value);
  if (nodes === null) return [LINEAR_INCOMPLETE];
  let matches = 0;
  let matchedStatus = '';
  for (const node of nodes) {
    if (!isObject(node) || typeof node.name !== 'string' || typeof node.status !== 'string') return [LINEAR_INCOMPLETE];
    if (node.name === version) {
      matches++;
      matchedStatus = node.status;
    }
  }
  if (matches === 0) return [{ status: 'missing', detail: 'no matching Linear milestone found' }];
  if (matches > 1) return [{ status: 'unknown', detail: 'multiple matching Linear milestones found' }];
  return matchedStatus === 'done' ? [] : [{ status: 'missing', detail: 'matching Linear milestone is incomplete' }];
}

// Only updates with archivedAt null participate. A qualifying update's server-supplied
// createdAt is at or after the release date at 00:00:00Z; future-dated updates qualify. An
// absent or invalid selected timestamp or archive state makes the record incomplete.
function updateConditions(value: unknown, releaseAt: number): Outcome[] {
  const nodes = relationNodes(value);
  if (nodes === null) return [LINEAR_INCOMPLETE];
  let qualifying = 0;
  for (const node of nodes) {
    if (!isObject(node)) return [LINEAR_INCOMPLETE];
    const { createdAt, archivedAt } = node;
    const created = typeof createdAt === 'string' ? timestampOf(createdAt) : null;
    if (created === null) return [LINEAR_INCOMPLETE];
    if (archivedAt !== null && (typeof archivedAt !== 'string' || timestampOf(archivedAt) === null)) return [LINEAR_INCOMPLETE];
    if (archivedAt === null && created >= releaseAt) qualifying++;
  }
  return qualifying > 0 ? [] : [{ status: 'missing', detail: 'no qualifying Linear status update found' }];
}

// RFC 3339 with seconds, a numeric offset or Z, and at most nine fractional digits, compared as
// an instant. Fail-closed by construction: a leap second and a lowercase t/z read as invalid.
const RFC3339 = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/** The instant an RFC 3339 timestamp names, in milliseconds, or null when it is not one. */
export function timestampOf(text: string): number | null {
  const match = RFC3339.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // RFC 3339's day of month is 01-31: day 00 is not a date, and must not roll back into the month before.
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = match[7] as string;
  let offset = 0;
  if (zone !== 'Z') {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offset = (zh * 60 + zm) * 60_000 * (zone.startsWith('+') ? 1 : -1);
  }
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getTime() - offset;
}

/* The activity read: the marker line in the configured public file, exactly once. */

async function activityCheck(
  reader: Reader,
  base: string,
  config: { file: string; marker: string },
  repo: Repo,
  name: string,
  version: string,
): Promise<Outcome> {
  // The default branch gates the read: a definitively missing repository makes it not required.
  if (repo.kind === 'missing') return { status: 'missing', detail: 'public activity marker is missing' };
  if (repo.kind === 'unknown') return { status: 'unknown', detail: 'public activity file could not be read' };
  const path = config.file.split('/').map(encodeSegment).join('/');
  const record = recordOf(await reader.read(`${base}/contents/${path}?ref=${encodeSegment(repo.branch)}`));
  if (record.kind === 'missing') return { status: 'missing', detail: 'public activity marker is missing' };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'public activity file could not be read' };
  const text = decodeContents(record.value);
  if (text === null) return { status: 'unknown', detail: 'public activity file could not be read' };
  // The requested literal values into the marker's two slots.
  const marker = config.marker.split('<package>').join(name).split('<version>').join(version);
  // Lines split on LF or CRLF only; a final delimiter creates no extra line, every other byte —
  // trailing spaces and tabs included — is data.
  const lines = text.split(/\r\n|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const found = lines.filter((line) => line === marker).length;
  if (found === 0) return { status: 'missing', detail: 'public activity marker is missing' };
  if (found > 1) return { status: 'unknown', detail: 'multiple public activity markers found' };
  return { status: 'pass', detail: 'public activity marker found' };
}
