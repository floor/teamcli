// A registered owner seat for hermetic tests: an in-memory credential store holding a P-256 key
// (the Secure Enclave stand-in), the seat record and the entity's owner-signers policy, all
// under the scene's own home. Never the machine's ~/.config/team, never the system store.

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acceptOwnerSigner, registerOwnerSeat, type OwnerSeatKeyStore } from '../../src/client/owner-seat.ts';
import { keyOf } from '../../src/store/keys.ts';

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

export type FakeStore = OwnerSeatKeyStore & { prompts: string[] };

export function fakeOwnerStore(): FakeStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  return {
    prompts,
    name: 'fake-credential-store',
    available: () => true,
    create: (label) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message, reason) => { prompts.push(reason); return keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }; },
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

/** Registers the owner seat (team/entity `floor`, signer `mac`) under `home` and accepts the signer. */
export function seatOwner(home: string, store: FakeStore = fakeOwnerStore(), signer = 'mac'): FakeStore {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const made = registerOwnerSeat(home, { team: 'floor', signer }, store);
  if (!made.ok) throw new Error(made.why);
  const accepted = acceptOwnerSigner(home, 'floor', signer);
  if (!accepted.ok) throw new Error(accepted.why);
  return store;
}
