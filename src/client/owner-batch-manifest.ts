// The set a batch of carried answers was signed as. One user-presence prompt answers several
// requests; each answer is still its own signature over its own request, and beside them the same
// signer signs one manifest: the machine and account the batch is for, and every member in order
// — its request id, its parameter hash and the digest of the exact answer signed for it. The
// machine that runs the requests records a batch only when the manifest verifies against its
// pinned owner seat and names exactly the answers the file carries, in that order: a member
// reordered, dropped, added or replaced by an answer from another ceremony refuses the batch.
// The manifest grants nothing on its own; every answer is checked again as if it came alone.

import { createHash } from 'node:crypto';
import { ownerSeatAnswerBytes, signatureOk, type OwnerSeatAnswer } from './owner-signature.ts';
import { plainObject, type OwnerPin } from './owner-pin-verify.ts';
import { validMachineBinding, type MachineBinding } from './owner-request-record.ts';

export const OWNER_BATCH_MANIFEST_DOMAIN = 'team-owner-batch-manifest-v1\n';

export type BatchMember = { request_id: string; params_sha256: string; answer_sha256: string };

export type BatchManifest = {
  kind: 'owner-batch';
  machine: MachineBinding;
  /** The account every member names, on a machine whose accounts share one owner; null elsewhere. */
  account: string | null;
  signer: string;
  at: string;
  members: BatchMember[];
};

export type SignedBatchManifest = { manifest: BatchManifest; signature: string };

/** The digest of the exact answer bytes a member's signature covers. */
export function answerDigest(answer: OwnerSeatAnswer): string {
  return createHash('sha256').update(ownerSeatAnswerBytes(answer)).digest('hex');
}

/** The bytes a manifest is signed over: the domain and one canonical JSON, members in order. */
export function batchManifestBytes(manifest: BatchManifest): Buffer {
  const canonical = {
    kind: manifest.kind,
    machine: { id: manifest.machine.id, name: manifest.machine.name },
    account: manifest.account,
    signer: manifest.signer,
    at: manifest.at,
    members: manifest.members.map((member) => ({ request_id: member.request_id, params_sha256: member.params_sha256, answer_sha256: member.answer_sha256 })),
  };
  return Buffer.from(OWNER_BATCH_MANIFEST_DOMAIN + JSON.stringify(canonical), 'utf8');
}

function readManifest(raw: unknown): BatchManifest | null {
  if (!plainObject(raw) || raw.kind !== 'owner-batch' || !validMachineBinding(raw.machine)) return null;
  if (raw.account !== null && typeof raw.account !== 'string') return null;
  if (typeof raw.signer !== 'string' || typeof raw.at !== 'string' || !Array.isArray(raw.members)) return null;
  const members: BatchMember[] = [];
  for (const member of raw.members as unknown[]) {
    if (!plainObject(member) || typeof member.request_id !== 'string' || typeof member.params_sha256 !== 'string' || typeof member.answer_sha256 !== 'string') return null;
    members.push({ request_id: member.request_id, params_sha256: member.params_sha256, answer_sha256: member.answer_sha256 });
  }
  return { kind: 'owner-batch', machine: raw.machine, account: raw.account, signer: raw.signer, at: raw.at, members };
}

/**
 * A signed manifest, verified against the owner seat pinned on this machine: signed by a pinned,
 * accepted signer that holds a device key (a passkey signs one request per ceremony, never a
 * batch), over exactly these bytes.
 */
export function verifyPinnedBatchManifest(pin: OwnerPin, raw: unknown): { ok: true; manifest: BatchManifest } | { ok: false; why: string } {
  if (!plainObject(raw) || typeof raw.signature !== 'string') return { ok: false, why: 'the batch carries no signed manifest of its members' };
  const manifest = readManifest(raw.manifest);
  if (manifest === null) return { ok: false, why: 'the batch manifest cannot be read' };
  const signer = pin.body.signers.find((one) => one.name === manifest.signer);
  if (signer === undefined) return { ok: false, why: `"${manifest.signer}" is not a signer of the owner seat pinned on this machine` };
  if (!pin.body.accepted.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner seat pinned on this machine` };
  if (signer.type !== 'mac-keystore') return { ok: false, why: `signer "${signer.name}" cannot sign a batch manifest` };
  const sig = signatureOk(signer, signer.public_key, batchManifestBytes(manifest), '', raw.signature, undefined, 'batch manifest');
  if (!sig.ok) return sig;
  return { ok: true, manifest };
}
