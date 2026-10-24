import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { KEY_ISOLATION_LINE, clientKeyPlacementProblem, newClientKeyPair, writeClientKeyFiles } from '../client/records.ts';
import { clientPaneGuard } from '../client/pane-guard.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team client keygen --out <dir> [--json]

keygen writes an Ed25519 client key pair into <dir> (created when absent, mode 700): client.key
holds the private half 0600 and client.pub holds the public half and the key id. The directory
must sit under ~/.config/team-client, outside every project, lobby and the OS temp folder.
key isolation: enforced against team panes (key file still readable by same-user processes).

Exits 0 when the key is written, 1 when refused, 2 when the invocation is invalid.
`;
export const client: Command = async (argv, io) => runClient(argv, io);
export default client;

export function runClient(argv: string[], rawIo: Io, home: string = homedir()): number {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['out'], ['json']);
  const sub = args.rest[0];
  if (sub === undefined) {
    io.stderr(`team client: a subcommand is required\n${USAGE}`);
    return 2; // exit: client.usage
  }
  if (sub === 'keygen') return runKeygen(args, rawIo, io, home);
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
