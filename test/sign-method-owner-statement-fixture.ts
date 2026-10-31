// tester-3 test-only fixtures for the independent owner-statement coverage. Generic synthetic
// material only: an Ed25519 pair, canonical byte helpers and a throwaway home folder. Nothing here
// touches a real credential store, session file, activation or remote.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SignProof } from '../src/policy/sign-method.ts';
import {
  createInertOwnerRequest, createOwnerStatement, OWNER_KIND_CLASSES,
  type InertOwnerContext, type InertOwnerRequest, type OwnerAct, type OwnerClass, type OwnerOperation,
  type SyntheticRegisteredOwnerSigner, type SyntheticTerminalPlacement,
} from '../src/signing/owner-request.ts';
import {
  ownerValueHash, signSyntheticOwnerStatement, type OwnerDecision, type OwnerSignerType,
  type OwnerStandingRule, type OwnerStatement, type OwnerTranscript,
} from '../src/signing/owner-statement.ts';
import type { Json } from '../src/store/keys.ts';

export type SyntheticWorld = {
  base: string;
  home: string;
  cleanup: () => void;
};

/** A throwaway world: a real path under the system temp folder and an empty synthetic home. */
export function world(prefix = 't3-owner-statement-'): SyntheticWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { base, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export type SyntheticOwner = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
};

/** A synthetic Ed25519 owner pair; the id is the SHA-256 of the SPKI DER, as the product's is. */
export function owner(): SyntheticOwner {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicKey,
    keyId: sha256(publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
  };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sign exact bytes (Ed25519 hashes internally); the test controls the bytes, not the product. */
export function signBytes(key: KeyObject, bytes: Uint8Array): string {
  return sign(null, bytes, key).toString('base64');
}

export function verifyBytes(key: KeyObject, bytes: Uint8Array, signature: string): boolean {
  try {
    return verify(null, bytes, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Verify the module's hex signature independently of its verifier. */
export function verifyHex(key: KeyObject, bytes: Uint8Array, signature: string): boolean {
  try {
    return verify(null, bytes, key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** A mutable clock the scenes can advance without sleeping. */
export function clock(at: string): { at: Date; now: () => Date; set: (next: string) => void } {
  const state = { at: new Date(at) };
  return {
    get at() {
      return state.at;
    },
    now: () => state.at,
    set: (next: string) => {
      state.at = new Date(next);
    },
  };
}

/** Deep copy through JSON so a scene cannot mutate a value it already signed. */
export function frozen<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A test-side reference encoder for the documented wire (sorted keys, dense arrays, no
 * whitespace). It shares no code with the module under test. */
export function independentCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => independentCanonical(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${independentCanonical(record[key])}`).join(',')}}`;
  }
  throw new Error('independentCanonical: unsupported value');
}

export const OWNER_NOW = '2026-10-23T08:00:00.000Z';
export const OWNER_AT = '2026-10-23T08:00:01.000Z';
export const OWNER_NONCE = 'ab'.repeat(32);

let ownerSeq = 0;
/** A fresh request id per scene: every request must be identifiable apart. */
export function nextOwnerId(prefix = 'req'): string {
  ownerSeq += 1;
  return `${prefix}-${ownerSeq}`;
}

export type OwnerActSpec = {
  operation?: OwnerOperation;
  payload?: { [key: string]: Json };
  class?: OwnerClass;
  requestId?: string;
  level?: 'entity' | 'project' | 'team';
  target?: string;
  artifact?: Json;
  inputState?: Json;
};

export function ownerAct(spec: OwnerActSpec = {}): OwnerAct {
  const operation = spec.operation ?? 'publish';
  return {
    class: spec.class ?? OWNER_KIND_CLASSES[operation],
    operation,
    level: spec.level ?? 'team',
    target: spec.target ?? 'blue',
    artifact: spec.artifact ?? { kind: 'none' },
    payload: spec.payload ?? {},
    input_state: spec.inputState ?? { state: 'one' },
    request_id: spec.requestId ?? nextOwnerId(),
  };
}

export function grantOwnerAct(
  commands: string[] = ['send'],
  capabilities: string[] = ['read'],
  extra: { [key: string]: Json } = {},
  spec: OwnerActSpec = {},
): OwnerAct {
  return ownerAct({ ...spec, payload: { commands, capabilities, ...extra } });
}

export function ownerRequest(
  spec: OwnerActSpec = {},
  host: { requester?: string; selfRequest?: boolean; now?: Date } = {},
): InertOwnerRequest {
  return createInertOwnerRequest(ownerAct(spec), {
    requester: host.requester ?? 'tester-seat',
    selfRequest: host.selfRequest ?? false,
    now: host.now ?? new Date(OWNER_NOW),
  });
}

export type OwnerAnswerSpec = {
  nonce?: string;
  choice?: OwnerDecision;
  standingRule?: OwnerStandingRule | null;
  signerId?: string;
  signerType?: OwnerSignerType;
  time?: string;
};

export function ownerStatement(request: InertOwnerRequest, key: SyntheticOwner, spec: OwnerAnswerSpec = {}): OwnerStatement {
  return createOwnerStatement(request, {
    nonce: spec.nonce ?? OWNER_NONCE,
    choice: spec.choice ?? 'once',
    standingRule: spec.standingRule ?? null,
    signerId: spec.signerId ?? key.keyId,
    signerType: spec.signerType ?? 'mac-keystore',
    time: spec.time ?? OWNER_AT,
  });
}

export function ownerTranscript(request: InertOwnerRequest, key: SyntheticOwner, spec: OwnerAnswerSpec = {}): OwnerTranscript {
  return signSyntheticOwnerStatement(ownerStatement(request, key, spec), key.privateKey);
}

export function registeredOwner(
  key: SyntheticOwner,
  type: OwnerSignerType = 'mac-keystore',
  method: SignProof = 'touch-id',
): SyntheticRegisteredOwnerSigner {
  return { id: key.keyId, type, method, publicKey: key.publicKey };
}

export function terminalSigner(id = 'terminal-owner'): SyntheticRegisteredOwnerSigner {
  return { id, type: 'terminal', method: 'terminal', publicKey: null };
}

export function standingRule(overrides: Partial<OwnerStandingRule> = {}): OwnerStandingRule {
  return {
    kind: 'publish',
    scope: {},
    bounds: { count: 1 },
    expires_at: '2026-10-23T09:00:00.000Z',
    ...overrides,
  };
}

export function ownerContext(
  request: InertOwnerRequest,
  signers: readonly SyntheticRegisteredOwnerSigner[] | null,
  spec: Partial<InertOwnerContext> = {},
): InertOwnerContext {
  return {
    now: new Date(OWNER_AT),
    verifiedRequestHash: ownerValueHash(request),
    currentAct: request.act,
    expectedNonce: OWNER_NONCE,
    signers,
    method: 'touch-id',
    floor: null,
    minAssurance: 'low',
    alwaysAllowed: true,
    signerMode: 'any',
    spentRequestIds: [],
    ...spec,
  };
}

export function terminalPlacement(request: InertOwnerRequest): SyntheticTerminalPlacement {
  return {
    request_id: request.request_id,
    act_digest: ownerValueHash(request.act),
    owner: true,
    terminal: true,
    unattended: false,
  };
}
