// `team owner-seat`: the owner seat, run by an agent (Iris) on the owner's behalf. The owner never
// types a command: every step that needs the owner ends in a native prompt on the owner's own
// device (Touch ID from the Secure Enclave helper, or a passkey on the owner page), and that
// signature is the authority, not the caller.
//
//   team owner-seat [status]                                   the seat, its signers, the security profile
//   team owner-seat setup --team <team> --signer <name> [--entity <e>]
//                                                              Secure Enclave key + one Touch ID to confirm
//   team owner-seat profile <strict|relaxed|dev> [--days N] [--reason <text>] [--signer <name>]
//                                                              proposes the profile; a Secure Enclave signer
//                                                              signs now (Touch ID), a passkey signs on the page
//   team owner-seat serve [--port N]                           the owner page (passkeys, profile, team requests)
import { renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { ownerSeatFile, readOwnerSeat, registerOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { writePolicySet } from '../policy/sources.ts';
import { serveOwnerPage } from '../security/owner-page.ts';
import { audit, MAX_PROFILE_DAYS, profileNameOf, proposeSecurityProfile, readSecurityProfile, securityProfileLine, signSecurityProfile } from '../security/profile.ts';

export const USAGE = `Usage: team owner-seat [status] [--json]
       team owner-seat setup --team <team> --signer <name> [--entity <entity>] [--owner-signers <a,b>] [--grant-emission <value>] [--policy-entity <entity>]
       team owner-seat profile <strict|relaxed|dev> [--days <1-${MAX_PROFILE_DAYS}>] [--reason <text>] [--signer <name>]
       team owner-seat serve [--port <port>]

Exits 0 when done, 1 when refused, 2 when the invocation is invalid.
`;

export type OwnerSeatOptions = { home?: string; store?: OwnerSeatKeyStore; now?: () => Date; serve?: boolean };

export const ownerSeat: Command = (argv, io) => runOwnerSeat(argv, io);
export default ownerSeat;

export async function runOwnerSeat(argv: string[], rawIo: Io, options: OwnerSeatOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['team', 'signer', 'entity', 'days', 'reason', 'port', 'owner-signers', 'grant-emission', 'policy-entity'], ['json']);
  const home = options.home ?? homedir();
  const store = options.store ?? systemOwnerSeatKeyStore();
  const now = options.now ?? (() => new Date());
  const sub = args.rest[0] ?? 'status';
  const refuse = (why: string, code = 1) => { io.stderr(`team owner-seat: ${why}\n`); return code; };
  if (args.error !== undefined) return refuse(`${args.error}\n${USAGE}`, 2);

  if (sub === 'status') {
    const seat = readOwnerSeat(home);
    const line = securityProfileLine(readSecurityProfile(home, store, now()));
    if (args.flags.has('json')) {
      io.stdout(`${JSON.stringify({ format: 1, seat: seat === null ? null : { team: seat.team, entity: seat.entity, signers: seat.signers.map((s) => ({ name: s.name, type: s.type })) }, security_profile: line, relaxed: /RELAXED/.test(line) })}\n`);
    } else {
      io.stdout(`${seat === null ? 'owner seat: none' : `owner seat: owner@${seat.team} (entity ${seat.entity}); signers: ${seat.signers.map((s) => `${s.name} (${s.type})`).join(', ')}`}\n${line}\n`);
    }
    return 0;
  }

  if (sub === 'setup') {
    if (args.values.team === undefined || args.values.signer === undefined) return refuse('setup needs --team <team> and --signer <name>', 2);
    const made = registerOwnerSeat(home, { team: args.values.team, signer: args.values.signer, ...(args.values.entity !== undefined ? { entity: args.values.entity } : {}) }, store, now());
    if (!made.ok) return refuse(made.why);
    // The owner's presence confirms the seat: one Touch ID (or login password) on this Mac. An
    // agent can create a Secure Enclave key, but only the owner can make it sign.
    // The same Touch ID also covers the entity policies named here, so setup is one owner act.
    const signer = made.record.signers[0]!;
    const policies: Array<{ name: string; value: unknown }> = [];
    if (args.values['owner-signers'] !== undefined) policies.push({ name: 'owner-signers', value: args.values['owner-signers'].split(',').map((n) => n.trim()).filter(Boolean) });
    if (args.values['grant-emission'] !== undefined) policies.push({ name: 'grant-emission', value: args.values['grant-emission'] });
    const policyEntity = args.values['policy-entity'] ?? made.record.entity;
    const said = policies.length === 0 ? '' : ` and set ${policies.map((p) => `${p.name}=${Array.isArray(p.value) ? p.value.join(',') : String(p.value)}`).join(', ')} for entity ${policyEntity}`;
    const confirmed = store.sign(signer.label, Buffer.from(`team-owner-seat-setup-v1\n${JSON.stringify({ team: made.record.team, public_key: signer.public_key, entity: policyEntity, policies })}`, 'utf8'), `Create the TeamCLI owner seat for ${made.record.team}${said}`);
    if (!confirmed.ok) {
      renameSync(ownerSeatFile(home), `${ownerSeatFile(home)}.unconfirmed-${now().getTime()}`);
      audit(home, 'seat-unconfirmed', { team: made.record.team, why: confirmed.why }, now());
      return refuse(`the owner did not confirm the seat (${confirmed.why}); nothing is registered`);
    }
    audit(home, 'seat-registered', { team: made.record.team, signer: signer.name, policies }, now());
    for (const p of policies) {
      const wrote = writePolicySet(home, { level: 'entity', target: policyEntity, name: p.name, value: p.value } as never, { now: now() });
      if (!wrote.ok) return refuse(`seat registered, but policy ${p.name} was not set (${wrote.why})`);
      io.stdout(`policy: entity ${policyEntity} ${p.name} set\n`);
    }
    io.stdout(`owner seat: registered owner@${made.record.team}, confirmed by Touch ID\nsigner: ${signer.name} (Secure Enclave)\n`);
    return 0;
  }

  if (sub === 'profile') {
    const name = profileNameOf(args.rest[1] ?? '');
    if (name === null) return refuse('profile is strict, relaxed or dev', 2);
    const days = args.values.days === undefined ? 7 : Number(args.values.days.replace(/d$/, ''));
    const proposed = proposeSecurityProfile(home, { profile: name, days, reason: args.values.reason ?? `${name} profile`, ...(args.values.signer !== undefined ? { signer: args.values.signer } : {}) }, now());
    if (!proposed.ok) return refuse(proposed.why);
    const seat = readOwnerSeat(home)!;
    const signer = seat.signers.find((s) => s.name === proposed.body.signer)!;
    if (signer.type === 'webauthn') {
      io.stdout(`security profile ${name} until ${proposed.body.expires} proposed for passkey "${signer.name}"\nthe owner approves it on the owner page (team owner-seat serve), challenge ${proposed.challenge}\n`);
      return 0;
    }
    const signed = signSecurityProfile(home, store, undefined, now());
    if (!signed.ok) return refuse(`the profile was not signed (${signed.why})`);
    io.stdout(`${securityProfileLine(readSecurityProfile(home, store, now()))}\n`);
    return 0;
  }

  if (sub === 'serve') {
    const page = await serveOwnerPage({ home, store, ...(args.values.port !== undefined ? { port: Number(args.values.port) } : {}), now });
    io.stdout(`owner page: ${page.url}\nopen it on this Mac; a passkey approval can use the iPhone through the browser's QR code. Ctrl-C stops it.\n`);
    if (options.serve === false) page.server.close();
    else await new Promise<void>((resolve) => page.server.on('close', () => resolve()));
    return 0;
  }
  return refuse(`unknown subcommand "${sub}"\n${USAGE}`, 2);
}
