// `team setup`: the one owner signature. An agent may start it. Nothing is written until the
// owner signs the charter — Touch ID on this Mac, or one passkey assertion from the iPhone.
// Key creation is not a signature. A cancelled sign writes nothing.

import { verify as cryptoVerify } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import {
  acceptOwnerSigner,
  addOwnerSigner,
  ownerSeatFile,
  ownerSeatPublicKey,
  ownerSignerLabel,
  readOwnerSeat,
  registerOwnerSeat,
  systemOwnerSeatKeyStore,
  type OwnerSeatKeyStore,
  type OwnerSeatRecord,
  type OwnerSigner,
} from '../client/owner-seat.ts';
import {
  charterStatement,
  defaultCharterBody,
  defaultProjectRoots,
  parseDuration,
  type CharterBody,
  type CharterLifetimes,
} from '../charter/body.ts';
import { readCharter, writeCharter, type CharterRead } from '../charter/store.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { OWNER_PAGE_RP_ID } from '../security/owner-page.ts';

export const USAGE = `Usage: team setup --signer <touch-id|passkey> [--roots <dirs>] [--team <team>] [--edit] [--request-expiry <duration>] [--rule-lifetime <duration>] [--grant-duration <duration>] [--public-key <hex>] [--signature <hex>] [--credential-id <id>] [--json]

Signs the owner charter once. --signer touch-id (or mac) creates the owner seat's
Secure Enclave key when there is none, then asks for Touch ID on the charter.
--signer passkey (or iphone) checks one signature over that same charter and
records the passkey; it does not create a Mac key. Roots default to the project
directories under the home (or ~/Code). Durations are 15m, 30d, 7d, or never.
--edit re-signs. A cancelled sign writes nothing.

Exits 0 when the charter is signed, 1 when the owner does not sign, 2 when the invocation is invalid.
`;

export type SetupOptions = { home?: string; store?: OwnerSeatKeyStore; now?: () => Date };

type Outcome = 'done' | 'refused' | 'invocation';

export const setup: Command = (argv, io) => runSetup(argv, io);
export default setup;

export async function runSetup(argv: string[], rawIo: Io, options: SetupOptions = {}): Promise<number> {
  const outcome = await setupOutcome(argv, rawIo, options);
  if (outcome === 'invocation') {
    // exit: setup.invocation
    return 2;
  }
  if (outcome === 'refused') {
    // exit: setup.refused
    return 1;
  }
  // exit: setup.done
  return 0;
}

async function setupOutcome(argv: string[], rawIo: Io, options: SetupOptions): Promise<Outcome> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, [
    'signer', 'roots', 'team', 'request-expiry', 'rule-lifetime', 'grant-duration', 'public-key', 'signature', 'credential-id',
  ], ['edit', 'json']);
  const home = options.home ?? homedir();
  const store = options.store ?? systemOwnerSeatKeyStore();
  const now = options.now ?? (() => new Date());
  const fail = (why: string, outcome: Outcome = 'refused'): Outcome => {
    io.stderr(`team setup: ${why}\n`);
    return outcome;
  };
  if (args.error !== undefined || args.rest.length > 0) return fail(args.error ?? `unexpected "${args.rest[0]}"\n${USAGE}`, 'invocation');
  const choice = signerChoice(args.values.signer);
  if (choice === null) return fail('--signer is touch-id (or mac) or passkey (or iphone); the owner chooses in this step, and this run does not sign', 'invocation');

  const parsedRoots = parseRoots(args.values.roots, io.cwd);
  if (typeof parsedRoots === 'string') return fail(parsedRoots, 'invocation');
  const lifetimes = parseLifetimes(args.values);
  if (typeof lifetimes === 'string') return fail(lifetimes, 'invocation');

  const existing = readCharter(home, store);
  if (args.flags.has('edit') && existing.kind === 'invalid') return fail(`${existing.why}; nothing was written`);
  const roots = parsedRoots ?? (existing.kind === 'ok' ? existing.charter.body.roots : defaultProjectRoots(home));
  const body = charterBody(existing, roots, lifetimes);
  const statement = charterStatement(body);
  let createdSeat = false;
  const undo = (why: string): Outcome => {
    if (createdSeat) {
      try { renameSync(ownerSeatFile(home), `${ownerSeatFile(home)}.unconfirmed-${now().getTime()}`); } catch { /* not ours */ }
    }
    return fail(`the owner did not sign the charter (${why}); nothing was written`);
  };

  let seat = readOwnerSeat(home);
  const team = args.values.team ?? seat?.team ?? 'owner';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(team)) return fail(`"${team}" is not a team name`, 'invocation');

  if (choice.type === 'webauthn') {
    const point = args.values['public-key'];
    const signature = args.values.signature;
    const credentialId = args.values['credential-id'];
    if (point === undefined || signature === undefined || credentialId === undefined) {
      return fail('a passkey charter needs --public-key, --signature and --credential-id; this run does not sign', 'invocation');
    }
    if (!verifies(point, statement, signature)) return fail('the passkey signature does not verify over the charter; nothing was written');
    if (seat === null) {
      const label = ownerSignerLabel(home, team, choice.name);
      const pinned = store.pinSet(label, point);
      if (!pinned.ok) return fail(pinned.why);
      const written = writePasskeySeat(home, { team, signer: choice.name, publicKey: point, credentialId, label }, now());
      if (!written.ok) return fail(written.why);
      seat = written.record;
      createdSeat = true;
    } else if (!seat.signers.some((one) => one.name === choice.name)) {
      const added = addOwnerSigner(home, { signer: choice.name, type: 'webauthn', publicKey: point, credentialId, rpId: OWNER_PAGE_RP_ID }, store, now());
      if (!added.ok) return fail(added.why);
      seat = readOwnerSeat(home) ?? seat;
    }
    const accepted = acceptOwnerSigner(home, seat.entity, choice.name, now());
    if (!accepted.ok) return undo(accepted.why);
    const saved = writeCharter(home, { format: 1, body, signer: choice.name, signature });
    if (!saved.ok) return undo(saved.why);
    return report(io, args.flags.has('json'), choice.name, 'passkey', body, saved.path);
  }

  if (seat === null) {
    const made = registerOwnerSeat(home, { team, signer: choice.name }, store, now());
    if (!made.ok) return fail(made.why);
    seat = made.record;
    createdSeat = true;
  }
  const signer = macSigner(seat, choice.name);
  if (signer === undefined) return undo('the owner seat has no Touch ID signer; pass --signer passkey or register one');
  const signed = store.sign(signer.label, statement, `Sign the TeamCLI owner charter for ${seat.team}`);
  if (!signed.ok) return undo(signed.why);
  if (!verifies(signer.public_key, statement, signed.signature)) return undo('the charter signature does not verify under the Touch ID key');
  const accepted = acceptOwnerSigner(home, seat.entity, signer.name, now());
  if (!accepted.ok) return undo(accepted.why);
  const saved = writeCharter(home, { format: 1, body, signer: signer.name, signature: signed.signature });
  if (!saved.ok) return undo(saved.why);
  return report(io, args.flags.has('json'), signer.name, 'touch-id', body, saved.path);
}

function signerChoice(word: string | undefined): { type: 'mac-keystore' | 'webauthn'; name: 'mac' | 'iphone' } | null {
  if (word === undefined) return null;
  const text = word.toLowerCase();
  if (text === 'touch-id' || text === 'touchid' || text === 'mac') return { type: 'mac-keystore', name: 'mac' };
  if (text === 'passkey' || text === 'iphone') return { type: 'webauthn', name: 'iphone' };
  return null;
}

function macSigner(seat: OwnerSeatRecord, name: string): OwnerSigner | undefined {
  return seat.signers.find((one) => one.type === 'mac-keystore' && one.name === name)
    ?? seat.signers.find((one) => one.type === 'mac-keystore');
}

function verifies(point: string, statement: Buffer, signature: string): boolean {
  const key = ownerSeatPublicKey(point);
  try {
    return key !== null && cryptoVerify('sha256', statement, { key, dsaEncoding: 'der' }, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function parseRoots(word: string | undefined, cwd: string): string[] | undefined | string {
  if (word === undefined) return undefined;
  const roots = word.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (roots.length === 0) return '--roots names at least one directory';
  return roots.map((root) => (isAbsolute(root) ? root : resolve(cwd, root)));
}

function parseLifetimes(values: Record<string, string | undefined>): Partial<Pick<CharterLifetimes, 'request' | 'rule' | 'grant'>> | string {
  const one = (flag: string): number | null | string | undefined => {
    const word = values[flag];
    if (word === undefined) return undefined;
    const parsed = parseDuration(word);
    if (parsed === undefined) return `--${flag} is a duration like 15m, 30d or 7d, or never`;
    return parsed;
  };
  const request = one('request-expiry');
  if (typeof request === 'string') return request;
  const rule = one('rule-lifetime');
  if (typeof rule === 'string') return rule;
  const grant = one('grant-duration');
  if (typeof grant === 'string') return grant;
  const out: Partial<Pick<CharterLifetimes, 'request' | 'rule' | 'grant'>> = {};
  if (request !== undefined) out.request = request;
  if (rule !== undefined) out.rule = rule;
  if (grant !== undefined) out.grant = grant;
  return out;
}

function charterBody(existing: CharterRead, roots: string[], lifetimes: Partial<Pick<CharterLifetimes, 'request' | 'rule' | 'grant'>>): CharterBody {
  const base = existing.kind === 'ok' ? existing.charter.body : defaultCharterBody(roots);
  return { ...base, roots, grant_right: false, lifetimes: { ...base.lifetimes, ...lifetimes } };
}

function writePasskeySeat(
  home: string,
  input: { team: string; signer: string; publicKey: string; credentialId: string; label: string },
  now: Date,
): { ok: true; record: OwnerSeatRecord } | { ok: false; why: string } {
  const record: OwnerSeatRecord = {
    format: 2, team: input.team, entity: input.team, seat: 'owner', role: 'owner', human: true, lifecycle: 'running',
    signers: [{
      name: input.signer, type: 'webauthn', public_key: input.publicKey, label: input.label,
      credential_id: input.credentialId, rp_id: OWNER_PAGE_RP_ID, added: now.toISOString(),
    }],
    provenance: { registered_by: 'owner', note: 'created for the human owner', registered_at: now.toISOString() },
  };
  try {
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    writeFileSync(ownerSeatFile(home), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { ok: true, record };
  } catch {
    return { ok: false, why: 'the owner seat record could not be written' };
  }
}

function report(io: Io, json: boolean, signer: string, kind: 'touch-id' | 'passkey', body: CharterBody, path: string): Outcome {
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'signed', signer, kind, roots: body.roots, path })}\n`);
  else io.stdout(`owner charter: signed by ${signer} (${kind})\nroots: ${body.roots.join(', ')}\npath: ${path}\n`);
  return 'done';
}
