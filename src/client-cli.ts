// The owner-facing client half of the CLI: the grant and revocation forms of `team grant` and
// `team revoke`, plus the owner admission they share and the key-file reading keygen and grant
// share. The client record, its signature, the store and the lock are builder-4's
// `src/client/records.ts`; this file only prints what those functions answer and keeps every
// numeric exit in the command file that declares it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Args } from './args.ts';
import { describeCaller, isOwner, walkCaller } from './caller.ts';
import {
  CLIENT_GRANT_ID_PATTERN,
  CLIENT_PUBLIC_KEY_PATTERN,
  KEY_ISOLATION_LINE,
  appendClientRevocation,
  keyIdOf,
  publicRawOf,
  writeClientGrant,
} from './client/records.ts';
import type { Io } from './io.ts';
import { plainText } from './launch/plain.ts';
import { writeJson, writeJsonError } from './output/index.ts';

/** The client key the owner points `--public-key` at: the public half written by keygen, or
 *  the private key file itself, from which the public half is read and never printed. */
export type ClientPublicInput = {
  publicKey: string;
  keyId: string;
  keyDir: string;
};

function objectOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Reads one client key directory's public half (or its private key, for the public half). */
export function clientPublicInput(arg: string, cwd: string): { ok: true; key: ClientPublicInput } | { ok: false; why: string } {
  const path = resolve(cwd, arg);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, why: `the client key file ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})` };
  }
  const record = objectOf(text);
  if (record === null) return { ok: false, why: `the client key file ${path} is not a client key` };
  if (typeof record.private === 'string') {
    let derived: { publicKey: string; keyId: string };
    try {
      derived = publicRawOf(record.private);
    } catch {
      return { ok: false, why: `the client key file ${path} does not parse as an Ed25519 key` };
    }
    return { ok: true, key: { ...derived, keyDir: dirname(path) } };
  }
  if (typeof record.public_key !== 'string' || !CLIENT_PUBLIC_KEY_PATTERN.test(record.public_key)) {
    return { ok: false, why: `the client key file ${path} carries no 64-hex Ed25519 public key` };
  }
  const keyDir = typeof record.key_dir === 'string' ? record.key_dir : dirname(path);
  const keyId = typeof record.key_id === 'string' ? record.key_id : keyIdOf(record.public_key);
  return { ok: true, key: { publicKey: record.public_key, keyId, keyDir } };
}

/** The owner admission every client-form call shares: the one sentence a seat reads, and the
 *  `*.refused` error the JSON form writes. Returns true when the call may go on. */
export function clientOwnerAllows(command: 'grant' | 'revoke', rawIo: Io, io: Io, json: boolean): boolean {
  const caller = walkCaller(io);
  if (isOwner(caller)) return true;
  const message = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
  if (json) {
    writeJsonError(rawIo, `${command}.refused`, plainText(message), `the owner runs \`team ${command}\` from a terminal outside herdr`, 1, 'owner-only');
  } else {
    io.stderr(`team ${command}: ${message}\n`);
  }
  return false;
}

/** The problems the `--client` form of `team grant` owns, or null when the arguments are whole. */
export function clientGrantProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.flags.has('dry-run')) return '--dry-run belongs to the team-file forms; a client grant is issued or refused whole';
  if (args.rest.length > 0) return 'the --client form takes no positional arguments';
  if (args.values.client === undefined) return '--client is required';
  if (args.values.entity === undefined) return '--entity is required';
  if (args.values['public-key'] === undefined) return '--public-key is required';
  if (args.values.scope !== undefined) return '--scope belongs to the team-file form';
  if (args.values.capabilities !== undefined) return '--capabilities belongs to the standing-grant form';
  if (args.values.name !== undefined) return '--name belongs to the standing-grant form';
  return null;
}

/** The client form of `team grant`: owner-only, one fresh id per issuance, at most seven days. */
export function runClientGrantMode(rawIo: Io, io: Io, args: Args, json: boolean): 'ok' | 'refused' | 'invalid' {
  const problem = clientGrantProblem(args);
  if (problem !== null) {
    if (json) writeJsonError(rawIo, 'grant.invalid', plainText(problem), null);
    else io.stderr(`team grant: ${problem}\n`);
    return 'invalid';
  }
  if (!clientOwnerAllows('grant', rawIo, io, json)) return 'refused';
  const key = clientPublicInput(args.values['public-key']!, io.cwd);
  if (!key.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(key.why), null);
    else io.stderr(`team grant: ${key.why}\n`);
    return 'refused';
  }
  const result = writeClientGrant(homedir(), {
    clientId: args.values.client!,
    entity: args.values.entity!,
    publicKey: key.key.publicKey,
    keyId: key.key.keyId,
    keyDir: key.key.keyDir,
    ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
  });
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) {
    writeJson(io, 'team.grant', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'grant: updated',
      project: null,
      session: null,
      target: result.grant.grantId,
    });
  } else {
    io.stdout(`grant: updated\nclient grant: ${result.grant.grantId}\nclient: ${result.grant.clientId}\nexpires: ${result.grant.expires}\ngrant file: ${result.path}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/** The client form of `team revoke`: owner-only, appended by grant id and never overwritten. */
export function runClientRevokeMode(rawIo: Io, io: Io, grantId: string, json: boolean): 'ok' | 'refused' | 'invalid' {
  if (!CLIENT_GRANT_ID_PATTERN.test(grantId)) {
    if (json) writeJsonError(rawIo, 'revoke.invalid', plainText(`${JSON.stringify(grantId)} is not a client grant id`), null);
    else io.stderr(`team revoke: ${JSON.stringify(grantId)} is not a client grant id\n`);
    return 'invalid';
  }
  if (!clientOwnerAllows('revoke', rawIo, io, json)) return 'refused';
  const result = appendClientRevocation(homedir(), grantId);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'revoke.refused', plainText(result.why), null);
    else io.stderr(`team revoke: ${result.why}\n`);
    return 'refused';
  }
  if (json) {
    writeJson(io, 'team.revoke', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'revoke: updated',
      project: null,
      session: null,
      target: result.record.grantId,
    });
  } else {
    io.stdout(`revoke: updated\nclient grant revoked: ${result.record.grantId}\nrevocation file: ${result.path}\n`);
  }
  return 'ok';
}
