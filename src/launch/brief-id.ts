// The four identities a general seat brief carries, and the one derived id every leg computes.
//
// The incarnation (`inc_<12 lowercase hex>`) names one seat's delivery lifetime: it is minted
// when a seat first gets a brief and survives a reword, so a changed brief is a new record under
// the same lifetime. The runtime epoch (`run_<12 lowercase hex>`) is the claim's binding to a
// running process: a launch installs it into the reader it starts, and a receipt counts as a
// read only while it still matches. The expected id is the drop's file name; the sha256 is the
// delivered body's, so a record and its claim can be compared without trusting the text.
//
// The id is derived, never stored twice: the first `attempt` deliveries hash only the
// incarnation and the delivered body; a recovery after a name is held by a foreign file hashes
// the attempt number too, so the retry cannot land on the same name. The digest's first 32 hex
// digits are shaped as a lowercase RFC 4122 UUID, which is the only name a drop may have.
import { createHash, randomBytes } from 'node:crypto';

/** The id a general-brief delivery names: the lowercase UUID every drop record is named by. */
export const BRIEF_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One seat's delivery lifetime, minted by the launch or the rollout. */
export const BRIEF_INCARNATION_PATTERN = /^inc_[0-9a-f]{12}$/;

/** The runtime epoch a claim binds a running reader to, minted with the incarnation. */
export const BRIEF_EPOCH_PATTERN = /^run_[0-9a-f]{12}$/;

/** The three fields that bind a drop, a claim and a read receipt to one delivery. */
export type BriefBinding = { incarnation: string; sha256: string; epoch: string };

export function isBriefId(value: unknown): value is string {
  return typeof value === 'string' && BRIEF_ID_PATTERN.test(value);
}

export function isBriefIncarnation(value: unknown): value is string {
  return typeof value === 'string' && BRIEF_INCARNATION_PATTERN.test(value);
}

export function isBriefEpoch(value: unknown): value is string {
  return typeof value === 'string' && BRIEF_EPOCH_PATTERN.test(value);
}

export function mintBriefIncarnation(): string {
  return `inc_${randomBytes(6).toString('hex')}`;
}

export function mintBriefEpoch(): string {
  return `run_${randomBytes(6).toString('hex')}`;
}

/**
 * The expected drop id for one delivery: the first attempt hashes the incarnation and the
 * delivered body; a recovery attempt hashes the number between them too. `attempt` is a
 * non-negative integer; zero and one produce different ids even when nothing else changed, which
 * is exactly what a recovery needs.
 */
export function briefIdOf(incarnation: string, deliveredBody: string, attempt = 0): string {
  const material = attempt > 0
    ? `${incarnation}\n${String(attempt)}\n${deliveredBody}`
    : `${incarnation}\n${deliveredBody}`;
  const hex = createHash('sha256').update(material).digest('hex').slice(0, 32).split('');
  // The version and variant nibbles of a name-derived UUID: any lowercase UUID is a valid record
  // id, and these keep the id inside RFC 4122's shape.
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}
