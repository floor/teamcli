import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { KEY_ISOLATION_LINE, clientKeyPlacementProblem, newClientKeyPair, writeClientKeyFiles } from '../client/records.ts';
import { issueHeldGeneralGrant, issueOwnerGeneralGrant, parseEntities, parseOps } from '../client/general-grant.ts';
import { ownerSeatStep } from '../client/owner-action-step.ts';
import { clientPaneGuard } from '../client/pane-guard.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team client keygen --out <dir> [--json]
       team client general-grant --to <client-id> --public-key <client.pub> [--entities <a,b|*>] [--ops <list|all>] [--may-issue] [--days <n>] --request [--json]
       team client general-grant --to <client-id> --public-key <client.pub> [--entities <a,b|*>] [--ops <list|all>] [--may-issue] [--days <n>] --approval <id> [--json]
       team client general-grant --to <client-id> --public-key <client.pub> [--entities <a,b|*>] [--ops <list|all>] [--may-issue] [--days <n>] --via <grant.json> --key <client.key> [--json]

keygen writes an Ed25519 client key pair into <dir> (created when absent, mode 700): client.key
holds the private half 0600 and client.pub holds the public half and the key id. The directory
must sit under ~/.config/team-client, outside every project, lobby and the OS temp folder.
key isolation: enforced against team panes (key file still readable by same-user processes).

general-grant issues a general grant: every entity (or the listed ones) and the listed ops
(config, restart, up, down, abandon, send, messages, reply), applied with no per-action request.
The owner issues one through the owner seat (--request, Touch ID); a holder whose grant may issue
gives another principal a grant within its own (--via, --key): never to itself, never wider.

Exits 0 when the key is written, 1 when refused, 2 when the invocation is invalid.
`;
export const client: Command = async (argv, io) => runClient(argv, io);
export default client;

export function runClient(argv: string[], rawIo: Io, home: string = homedir()): number {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['out', 'to', 'public-key', 'entities', 'ops', 'days', 'approval', 'via', 'key'], ['json', 'request', 'may-issue']);
  const sub = args.rest[0];
  if (sub === undefined) {
    io.stderr(`team client: a subcommand is required\n${USAGE}`);
    return 2; // exit: client.usage
  }
  if (sub === 'keygen') return runKeygen(args, rawIo, io, home);
  if (sub === 'general-grant') return runGeneralGrant(argv, args, io, home);
  io.stderr(`team client: unknown subcommand "${sub}"\n${USAGE}`);
  return 2; // exit: client.unknown
}

function runKeygen(args: Args, rawIo: Io, io: Io, home: string): number {
  const json = args.flags.has('json');
  const problem = args.error ?? (args.rest.length > 1 ? 'keygen takes no positional arguments' : undefined) ?? (args.values.out === undefined ? '--out is required' : null);
  if (problem !== null) {
    if (json) writeJsonError(rawIo, 'client.keygen.invocation', plainText(problem), null);
    else io.stderr(`team client keygen: ${problem}\n${USAGE}`);
    return 2; // exit: client.keygen.invocation
  }
  // The pane guard, before any directory is checked or written: a seat never mints a client key.
  const pane = clientPaneGuard(rawIo, 'client keygen', home);
  if (!pane.ok) {
    if (json) writeJsonError(rawIo, 'client.keygen.pane', plainText(pane.why), null);
    else io.stderr(`team client keygen: refused: ${pane.why}\n`);
    return 1; // exit: client.keygen.pane
  }
  if (pane.warning !== undefined) io.stderr(`${pane.warning}\n`);
  const dir = resolve(io.cwd, args.values.out as string);
  const placement = clientKeyPlacementProblem(home, dir);
  if (placement !== null) {
    if (json) writeJsonError(rawIo, 'client.keygen.refused', plainText(placement), null);
    else io.stderr(`team client keygen: ${placement}\n`);
    return 1; // exit: client.keygen.refused
  }
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(dir, pair);
  if (!written.ok) {
    if (json) writeJsonError(rawIo, 'client.keygen.write', plainText(written.why), null);
    else io.stderr(`team client keygen: ${written.why}\n`);
    return 1; // exit: client.keygen.write
  }
  if (json) {
    writeJson(io, 'team.client.keygen', {
      format: 1 as const,
      status: 'created' as const,
      key_path: written.keyPath,
      public_key_path: written.pubPath,
      key_dir: dir,
      public_key: pair.publicKey,
      key_id: pair.keyId,
      key_isolation: KEY_ISOLATION_LINE,
    });
  } else {
    io.stdout(`client key: ${written.keyPath}\nclient public key: ${written.pubPath}\nclient public key id: ${pair.keyId}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 0; // exit: client.keygen.done
}

function runGeneralGrant(argv: string[], args: Args, io: Io, home: string): number {
  const json = args.flags.has('json');
  const bad = (why: string): number => {
    io.stderr(`team client general-grant: ${why}\n`);
    return 2; // exit: client.general-grant.invocation
  };
  if (args.error !== undefined) return bad(args.error);
  const to = args.values.to;
  const pubPath = args.values['public-key'];
  if (to === undefined || pubPath === undefined) return bad('--to and --public-key are required');
  const entities = parseEntities(args.values.entities);
  if (typeof entities === 'string') return bad(entities);
  const ops = parseOps(args.values.ops);
  if (typeof ops === 'string') return bad(ops);
  const days = args.values.days === undefined ? 30 : Number(args.values.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) return bad('--days is a whole number from 1 to 365');
  let publicKey: string;
  try {
    publicKey = String((JSON.parse(readFileSync(resolve(io.cwd, pubPath), 'utf8')) as { public_key?: unknown }).public_key ?? '');
  } catch {
    return bad(`"${pubPath}" is not a client.pub file`);
  }
  const now = new Date();
  const input = { clientId: to, publicKey, entities, ops, mayIssue: args.flags.has('may-issue'), expires: new Date(now.getTime() + days * 86_400_000) };
  const held = args.values.via !== undefined || args.values.key !== undefined;
  let out: ReturnType<typeof issueOwnerGeneralGrant>;
  if (held) {
    if (args.values.via === undefined || args.values.key === undefined) return bad('--via and --key go together');
    if (args.flags.has('request') || args.values.approval !== undefined) return bad('--via issues from a held grant; it takes no owner-seat flags');
    out = issueHeldGeneralGrant(home, resolve(io.cwd, args.values.via), resolve(io.cwd, args.values.key), input, now);
  } else {
    if (!args.flags.has('request') && args.values.approval === undefined) return bad('the owner issues through the owner seat (--request), or a holder issues with --via and --key');
    const step = ownerSeatStep('client', 'team-general-grant', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, { home });
    if (step.kind === 'requested') return 0; // exit: client.general-grant.requested
    if (step.kind !== 'admitted') {
      return 1; // exit: client.general-grant.refused
    }
    out = issueOwnerGeneralGrant(home, input, now);
  }
  if (!out.ok) {
    io.stderr(`team client general-grant: ${out.why}\n`);
    return 1; // exit: client.general-grant.failed
  }
  const g = out.grant;
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'issued', grant_id: g.grant_id, path: out.path, client_id: g.client_id, entities: g.entities, ops: g.ops, may_issue: g.may_issue, parent: g.parent, expires: g.expires })}\n`);
  else io.stdout(`general grant ${g.grant_id} issued to ${g.client_id}: entities ${g.entities.join(',')}; ops ${g.ops.join(',')}${g.may_issue ? '; may issue' : ''}; expires ${g.expires}\ngrant file: ${out.path}\n`);
  return 0; // exit: client.general-grant.issued
}
