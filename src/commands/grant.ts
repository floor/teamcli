import { homedir } from 'node:os';
import { readArgs, type Args } from '../args.ts';
import { runAuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { runAddOwnerSignerMode, runAddOwnerSeatMode, runOwnerSeatApproveMode, runOwnerSeatInboxMode, runAnswerGrantMode, runClientGrantMode, runDenyGrantMode, runExecuteGrantMode, runListApprovalsMode, runRevokeApprovalMode, type GrantApprovalOptions } from '../client-cli.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { runSendGrant, runStandingGrant } from '../permissions/manage.ts';

export const USAGE = `Usage: team grant <seat> --scope <act,...> [--dry-run] [--json]
       team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]
       team grant --send --from <side> --to <side> --expires <ISO> [--name <stem>] [--dry-run] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> [--team <team>] [--seat <seat>] [--expires <ISO|never>] [--inbox] [--allow-grant] [--grant-entity <entity,...>] [--grant-project <project-id,...>] [--grant-team <team,...>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --request [--team <team>] [--seat <seat>] [--expires <ISO|never>] [--inbox] [--allow-grant] [--grant-entity <entity,...>] [--grant-project <project-id,...>] [--grant-team <team,...>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --up [--down] [--expires <ISO|never>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --up [--down] --request [--expires <ISO|never>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --down [--expires <ISO|never>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --down --request [--expires <ISO|never>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --bundle <default|observer|operator|manager> [--seat <seats>] [--expires <ISO|never>] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> --team <team> [--bundle <default|observer|operator|manager>] --request [--seat <seats>] [--expires <ISO|never>] [--json]
       team grant --execute <request-id> --code <code> [--approve <once|always>] [--json]
       team grant --execute <request-id> [--json]
       team grant --answer <request-id> <oui|always|non> [--json]
       team grant --deny <request-id> [--json]
       team grant --add-owner-seat --team <team> --signer <name> [--entity <entity>] [--json]
       team grant --add-owner-signer --signer <name> --type <mac-keystore|webauthn> [--signer-public-key <hex>] [--credential-id <id>] [--rp-id <id>] [--json]
       team grant --approve-as-owner-seat <request-id> <oui|always|non> [--signer <name>] [--assertion <file>] [--at <ISO>] [--json]
       team grant --owner-seat-inbox [--json]
       team grant --approvals [--json]
       team grant --revoke-approval <rule-id> [--json]
       team grant --client-request --via <master-grant-file> --key <client-key> --client <client-id> --entity <entity> --public-key <file> [--team <team>] [--seat <seat>] [--expires <ISO>] [--inbox] [--json]

Exits 0 when the grant is written or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.
`;
export const grant: Command = (argv, io) => runGrant(argv, io);
export default grant;

/**
 * Writes an authority record, in one of two forms. With `--scope` and no `--capabilities` it edits
 * the team file's grant, exactly as before. With `--capabilities` it writes a standing grant
 * record: a seat names a registered agent and `@team` this project's team; the record is what the
 * gates read (src/permissions/manage.ts). With `--client` it writes the owner-signed client grant
 * the records module owns; `--allow-grant` makes it a master grant that carries `grant` and a scope.
 * Owner only in every form but one: `--client-request`, where a client presents its master grant
 * and a request signed with its key, and TeamCLI issues a sub-grant inside that master's scope.
 */
export async function runGrant(argv: string[], rawIo: Io, options: AuthorityEditOptions & GrantApprovalOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['scope', 'capabilities', 'expires', 'name', 'from', 'to', 'client', 'entity', 'public-key', 'seat', 'team', 'via', 'key', 'grant-entity', 'grant-project', 'grant-team', 'execute', 'code', 'approve', 'deny', 'revoke-approval', 'answer', 'approve-as-owner-seat', 'signer', 'type', 'signer-public-key', 'credential-id', 'rp-id', 'assertion', 'at', 'bundle'], ['dry-run', 'inbox', 'json', 'allow-grant', 'client-request', 'request', 'approvals', 'add-owner-seat', 'owner-seat-inbox', 'add-owner-signer', 'up', 'down', 'send']);
  const dryRun = args.flags.has('dry-run');
  let result: 'ok' | 'refused' | 'invalid';
  const approval: GrantApprovalOptions = {
    ...(options.notify !== undefined ? { notify: options.notify } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ownerSeatStore !== undefined ? { ownerSeatStore: options.ownerSeatStore } : {}),
  };
  const home = options.home ?? homedir();
  const alone = args.error === undefined && args.rest.length === 0 && args.values.client === undefined;
  if (args.error === undefined && args.flags.has('add-owner-seat') && args.values.team !== undefined && args.values.client === undefined && args.rest.length === 0) {
    result = runAddOwnerSeatMode(rawIo, io, args.values.team, json, home, approval, args);
  } else if (args.error === undefined && args.flags.has('add-owner-signer') && args.values.client === undefined && args.rest.length === 0) {
    result = runAddOwnerSignerMode(rawIo, io, args, json, home, approval);
  } else if (args.error === undefined && args.values['approve-as-owner-seat'] !== undefined && args.rest.length === 1 && args.values.client === undefined) {
    result = runOwnerSeatApproveMode(rawIo, io, args.values['approve-as-owner-seat'], args.rest[0]!, json, home, approval, args);
  } else if (alone && args.flags.has('owner-seat-inbox')) {
    result = runOwnerSeatInboxMode(io, json, home);
  } else if (args.error === undefined && args.values.answer !== undefined && args.rest.length === 1 && args.values.client === undefined) {
    result = runAnswerGrantMode(rawIo, io, args.values.answer, args.rest[0]!, json, home, options.now);
  } else if (alone && args.values.deny !== undefined) {
    result = runDenyGrantMode(rawIo, io, args.values.deny, json, home);
  } else if (alone && args.flags.has('approvals')) {
    result = runListApprovalsMode(io, json, home);
  } else if (alone && args.values['revoke-approval'] !== undefined) {
    result = runRevokeApprovalMode(rawIo, io, args.values['revoke-approval'], json, home);
  } else if (args.values.execute !== undefined && args.error === undefined && args.rest.length === 0 && !args.flags.has('request') && !args.flags.has('client-request')) {
    result = runExecuteGrantMode(rawIo, io, args, json, options.home ?? homedir(), approval);
  } else if (args.flags.has('send')) {
    const problem = sendInvocationProblem(args);
    if (problem !== null) return invocationFailure(rawIo, io, json, problem);
    result = runSendGrant(rawIo, {
      from: args.values.from!,
      to: args.values.to!,
      expires: args.values.expires!,
      ...(args.values.name !== undefined ? { name: args.values.name } : {}),
    }, { ...options, dryRun, json });
  } else if (args.values.client !== undefined) {
    result = runClientGrantMode(rawIo, io, args, json, options.home ?? homedir(), approval);
  } else {
    const problem = invocationProblem(args);
    if (problem !== null) return invocationFailure(rawIo, io, json, problem);
    const capabilities = args.values.capabilities;
    result = capabilities === undefined
      ? await runAuthorityEdit('grant', { kind: 'grant', seat: args.rest[0]!, scope: args.values.scope!.split(',') }, rawIo, { ...options, dryRun, json })
      : runStandingGrant(rawIo, {
          seat: args.rest[0]!,
          capabilities: capabilities.split(','),
          ...(args.values.scope !== undefined ? { scope: args.values.scope.split(',') } : {}),
          ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
          ...(args.values.name !== undefined ? { name: args.values.name } : {}),
        }, { ...options, dryRun, json });
  }
  if (result === 'refused') {
    return 1; // exit: grant.refused
  }
  if (result === 'invalid') {
    return 2; // exit: grant.invalid
  }
  return 0; // exit: grant.done
}

/** One invocation failure, in both the plain and the JSON spellings: exit 2, and the words name
 *  the form the flags would have written. Every invocation problem the forms share returns here,
 *  so the id has one site. */
function invocationFailure(rawIo: Io, io: Io, json: boolean, problem: string): 2 {
  if (json) {
    writeJsonError(rawIo, 'grant.invocation', plainText(problem), null);
  } else {
    io.stderr(`team grant: ${problem}\n${USAGE}`);
  }
  return 2; // exit: grant.invocation
}

/**
 * The problems of the `--send` form: it takes no positional, no other form's values or flags, and
 * all three of `--from`, `--to` and `--expires`. Returned as data like `invocationProblem`, so the
 * one marked `return 2` above carries the exit id.
 */
function sendInvocationProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.rest.length !== 0) return 'team grant --send takes no positional: the pair is --from and --to';
  for (const value of ['scope', 'capabilities', 'client', 'entity', 'public-key', 'seat', 'team', 'via', 'key', 'grant-entity', 'grant-project', 'grant-team', 'execute', 'code', 'approve', 'deny', 'revoke-approval', 'answer', 'approve-as-owner-seat', 'signer', 'type', 'signer-public-key', 'credential-id', 'rp-id', 'assertion', 'at', 'bundle'] as const) {
    if (args.values[value] !== undefined) {
      return `--${value} belongs to another form; team grant --send writes one send grant from --from, --to and --expires`;
    }
  }
  for (const flag of ['inbox', 'allow-grant', 'client-request', 'request', 'approvals', 'add-owner-seat', 'owner-seat-inbox', 'add-owner-signer', 'up', 'down'] as const) {
    if (args.flags.has(flag)) return `--${flag} belongs to another form; team grant --send writes one send grant from --from, --to and --expires`;
  }
  if (args.values.from === undefined) return '--from is required: the side the record admits as sender';
  if (args.values.to === undefined) return '--to is required: the side the record admits as receiver';
  if (args.values.expires === undefined) return '--expires is required: a send grant states when it stops';
  return null;
}

/**
 * The invocation problems the two team-file forms share, and the flags that belong to one form
 * alone. Returned as data: the one marked `return 2` above carries the exit id, and a call here in
 * a return expression would be walked as one.
 */
function invocationProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.flags.has('inbox')) return '--inbox belongs to the --client form: a grant that reads the client inbox';
  if (args.flags.has('client-request')) return '--client-request needs --client <client-id>';
  if (args.flags.has('request')) return '--request belongs to the --client form; conversational emission covers client grants only';
  if (args.values.code !== undefined) return '--code belongs to the execute form: team grant --execute <request-id> --code <code>';
  if (args.flags.has('allow-grant')) return '--allow-grant belongs to the --client form: a master client grant';
  if (args.flags.has('up') || args.flags.has('down')) return '--up and --down belong to the --client form: a client grant that lets the client run team up or team down for one team';
  if (args.values.bundle !== undefined) return '--bundle belongs to the --client form: a client grant that carries a named list of commands for one team';
  if (args.flags.has('approvals')) return '--approvals takes no other arguments';
  for (const flag of ['via', 'key', 'grant-entity', 'grant-project', 'grant-team', 'execute', 'approve', 'deny', 'revoke-approval', 'answer'] as const) {
    if (args.values[flag] !== undefined) return `--${flag} belongs to the --client form`;
  }
  if (args.rest.length !== 1) {
    return args.values.capabilities === undefined ? 'a seat and --scope are required' : 'one seat or @team is required';
  }
  if (args.values.capabilities !== undefined) return null;
  if (args.values.scope !== undefined) return null;
  if (args.values.expires !== undefined) return '--expires belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  if (args.values.name !== undefined) return '--name belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  if (args.values.entity !== undefined) return '--entity belongs to the --client form';
  if (args.values['public-key'] !== undefined) return '--public-key belongs to the --client form';
  if (args.values.seat !== undefined) return '--seat belongs to the --client form';
  if (args.values.team !== undefined) return '--team belongs to the --client form';
  return 'a seat and --scope are required';
}
