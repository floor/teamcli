// `team owner-seat`: the owner seat, run by an agent (the orchestrator) on the owner's behalf. The owner never
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
//   team owner-seat export --out <file> [--signer <name>]      the seat's public signer records, for a
//                                                              machine with no owner signer; one Touch ID
//   team owner-seat pin --from <file> [--name <machine>]       on that machine: pin the export (trust on
//                                                              first use; a change needs a pinned signer)
//   team owner-seat install --account <a,b> [--dry-run]        on a Linux machine whose accounts share one
//                                                              owner: the system owner state and its helper
import { verify as cryptoVerify } from 'node:crypto';
import { renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { readCarriedFile, writeCarriedFile } from '../client/owner-carry.ts';
import { exportOwnerSeat, fingerprintText, pinOwnerSeat, readOwnerPin } from '../client/owner-pin.ts';
import { installOwnerState, realInstallSystem, type InstallSystem } from '../client/owner-state-install.ts';
import { ownerSeatFile, ownerSeatPublicKey, readOwnerSeat, registerOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { writePolicySet } from '../policy/sources.ts';
import { serveOwnerPage } from '../security/owner-page.ts';
import { audit, MAX_PROFILE_DAYS, profileNameOf, proposeSecurityProfile, readSecurityProfile, securityProfileLine, signSecurityProfile } from '../security/profile.ts';

export const USAGE = `Usage: team owner-seat [--json]
       team owner-seat status [--json]
       team owner-seat setup --team <team> --signer <name> [--entity <entity>] [--owner-signers <a,b>] [--grant-emission <value>] [--policy-entity <entity>]
       team owner-seat profile <strict|relaxed|dev> [--days <1-30>] [--reason <text>] [--signer <name>]
       team owner-seat serve [--port <port>]
       team owner-seat export --out <file> [--signer <name>] [--json]
       team owner-seat pin --from <file> [--name <machine>] [--json]
       team owner-seat install --account <a,b> [--dry-run] [--json]

export writes the seat's public signer records (no private key) for a machine that holds no owner
signer, signed with one confirmation on the owner's device, and prints their fingerprint. pin, on that machine, trusts the
first export its owner gives it at a terminal there, and prints the same fingerprint to compare;
a changed seat needs a newer export signed by a signer already pinned. Once pinned, a terminal on
that machine is not the owner: owner-only actions there need the owner's signed answer.

install, on a Linux machine whose accounts share one owner, sets up the owner state every
account reads and none can change: run it once with sudo from the owner's own account, naming
the entity accounts; --dry-run prints every step and changes nothing. The pin there is then
made with sudo too.

Exits 0 when done, 1 when refused, 2 when the invocation is invalid.
`;

export type OwnerSeatOptions = { home?: string; store?: OwnerSeatKeyStore; now?: () => Date; serve?: boolean; installSystem?: InstallSystem };

export const ownerSeat: Command = (argv, io) => runOwnerSeat(argv, io);
export default ownerSeat;

export async function runOwnerSeat(argv: string[], rawIo: Io, options: OwnerSeatOptions = {}): Promise<number> {
  const outcome = await ownerSeatOutcome(argv, rawIo, options);
  if (outcome === 'invocation') {
    return 2; // exit: owner-seat.invocation
  }
  if (outcome === 'refused') {
    return 1; // exit: owner-seat.refused
  }
  return 0; // exit: owner-seat.done
}

type Outcome = 'done' | 'refused' | 'invocation';

async function ownerSeatOutcome(argv: string[], rawIo: Io, options: OwnerSeatOptions): Promise<Outcome> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['team', 'signer', 'entity', 'days', 'reason', 'port', 'owner-signers', 'grant-emission', 'policy-entity', 'out', 'from', 'name', 'account'], ['json', 'dry-run']);
  const home = options.home ?? homedir();
  const store = options.store ?? systemOwnerSeatKeyStore();
  const now = options.now ?? (() => new Date());
  const sub = args.rest[0];
  const refuse = (why: string, outcome: 'refused' | 'invocation' = 'refused'): Outcome => { io.stderr(`team owner-seat: ${why}\n`); return outcome; };
  if (args.error !== undefined) return refuse(`${args.error}\n${USAGE}`, 'invocation');
  const carryOptions = ['out', 'from', 'name'].filter((name) => args.values[name] !== undefined);
  if (sub !== 'export' && sub !== 'pin' && carryOptions.length > 0) return refuse(`--${carryOptions[0]} belongs to export or pin\n${USAGE}`, 'invocation');
  if (sub !== 'install' && (args.values.account !== undefined || args.flags.has('dry-run'))) return refuse(`--${args.values.account !== undefined ? 'account' : 'dry-run'} belongs to install\n${USAGE}`, 'invocation');

  if (sub === 'install') {
    if (args.values.account === undefined) return refuse('install needs --account <name>[,<name>]: the entity accounts that use this machine\'s owner', 'invocation');
    const accounts = args.values.account.split(',').map((name) => name.trim()).filter(Boolean);
    const dryRun = args.flags.has('dry-run');
    const outcome = await installOwnerState(options.installSystem ?? realInstallSystem(), accounts, dryRun);
    if (args.flags.has('json')) {
      io.stdout(`${JSON.stringify({ format: 1, status: outcome.ok ? (outcome.ran ? 'installed' : 'dry-run') : 'refused', ...(outcome.ok ? {} : { why: outcome.why }), accounts, steps: outcome.steps })}\n`);
      return outcome.ok ? 'done' : 'refused';
    }
    if (outcome.steps.length > 0) io.stdout(`${dryRun ? 'owner-seat install would run, as the administrator:' : 'owner-seat install:'}\n${outcome.steps.map((step) => `  ${step.what}\n    ${step.argv.join(' ')}`).join('\n')}\n`);
    if (!outcome.ok) return refuse(outcome.why);
    io.stdout(dryRun
      ? 'nothing was changed (--dry-run)\n'
      : `owner state set up for ${accounts.join(', ')}; next, pin the owner seat as the administrator: sudo team owner-seat pin --from <export file>\n`);
    return 'done';
  }

  if (sub === undefined || sub === 'status') {
    const seat = readOwnerSeat(home);
    const pin = readOwnerPin(home);
    const line = securityProfileLine(readSecurityProfile(home, store, now()));
    if (args.flags.has('json')) {
      const pinned = pin.kind === 'pinned'
        ? { team: pin.body.team, entity: pin.body.entity, signers: pin.body.signers.map((s) => ({ name: s.name, type: s.type })), accepted: pin.body.accepted, fingerprint: pin.fingerprint, pinned_at: pin.pinnedAt, machine: { id: pin.machine.id, name: pin.machine.name } }
        : pin.kind === 'refused' ? { refused: pin.why } : null;
      io.stdout(`${JSON.stringify({ format: 1, seat: seat === null ? null : { team: seat.team, entity: seat.entity, signers: seat.signers.map((s) => ({ name: s.name, type: s.type })) }, pinned, security_profile: line, relaxed: /RELAXED/.test(line) })}\n`);
    } else if (pin.kind === 'pinned') {
      io.stdout(`owner seat: pinned from another machine: owner@${pin.body.team} (entity ${pin.body.entity}); signers: ${pin.body.signers.map((s) => `${s.name} (${s.type})`).join(', ')}; accepted: ${pin.body.accepted.join(', ')}\nfingerprint: ${fingerprintText(pin.fingerprint)}\nthis machine: ${pin.machine.name} (${pin.machine.id}); a terminal here is not the owner\n${line}\n`);
    } else if (pin.kind === 'refused') {
      io.stdout(`owner seat: pinned from another machine, and the pin cannot be used (${pin.why}); no owner answer is accepted here, and a terminal here is not the owner\n${line}\n`);
    } else {
      io.stdout(`${seat === null ? 'owner seat: none' : `owner seat: owner@${seat.team} (entity ${seat.entity}); signers: ${seat.signers.map((s) => `${s.name} (${s.type})`).join(', ')}`}\n${line}\n`);
    }
    return 'done';
  }

  if (sub === 'export') {
    if (args.values.out === undefined) return refuse('export needs --out <file>', 'invocation');
    if (args.values.from !== undefined || args.values.name !== undefined) return refuse(`--${args.values.from !== undefined ? 'from' : 'name'} belongs to pin\n${USAGE}`, 'invocation');
    // One Touch ID on this machine signs the export; its card shows the fingerprint. The export
    // holds public keys only, so the file is no secret, and the signature is the authority.
    const made = exportOwnerSeat(home, store, now(), args.values.signer);
    if (!made.ok) return refuse(`the owner seat was not exported (${made.why})`);
    const written = writeCarriedFile(io.cwd, args.values.out, made.signed);
    if (!written.ok) return refuse(written.why);
    audit(home, 'seat-exported', { team: made.signed.owner_seat_export.team, signer: made.signed.signer, fingerprint: made.fingerprint }, now());
    const body = made.signed.owner_seat_export;
    if (args.flags.has('json')) {
      io.stdout(`${JSON.stringify({ format: 1, status: 'exported', file: written.path, fingerprint: fingerprintText(made.fingerprint), fingerprint_sha256: made.fingerprint, team: body.team, signers: body.signers.map((s) => ({ name: s.name, type: s.type })), accepted: body.accepted })}\n`);
    } else {
      io.stdout(`owner seat: exported owner@${body.team} to ${written.path}, signed by ${made.signed.signer}\nsigners: ${body.signers.map((s) => `${s.name} (${s.type})`).join(', ')}; accepted: ${body.accepted.join(', ')}\nfingerprint: ${fingerprintText(made.fingerprint)}\non the other machine, the owner pins it from a terminal there (team owner-seat pin --from <file>) and compares this fingerprint with the one it prints\n`);
    }
    return 'done';
  }

  if (sub === 'pin') {
    if (args.values.from === undefined) return refuse('pin needs --from <file>', 'invocation');
    if (args.values.out !== undefined || args.values.signer !== undefined) return refuse(`--${args.values.out !== undefined ? 'out' : 'signer'} belongs to export\n${USAGE}`, 'invocation');
    const read = readCarriedFile(io.cwd, args.values.from);
    if (!read.ok) return refuse(read.why);
    // The first pin is trust on first use, and it is the owner's: at a terminal on this machine,
    // before any pin, a terminal is still the owner. A pin already here is changed only by an
    // export signed by a signer it holds, whoever runs the command.
    const before = readOwnerPin(home);
    if (before.kind === 'none') {
      const caller = callerOf(io);
      if (!isOwner(caller)) return refuse(`the first pin is the owner's, from a terminal on this machine outside the terminal host (trust on first use); this call is ${describeCaller(caller)}`);
    }
    const pinned = pinOwnerSeat(home, read.value, now(), args.values.name !== undefined ? { name: args.values.name } : {});
    if (!pinned.ok) return refuse(`nothing was pinned (${pinned.why})`);
    if (pinned.kind !== 'same') audit(home, pinned.kind === 'pinned' ? 'seat-pinned' : 'seat-repinned', { team: pinned.team, fingerprint: pinned.fingerprint, previous: pinned.previous, machine: pinned.machine.id }, now());
    if (args.flags.has('json')) {
      io.stdout(`${JSON.stringify({ format: 1, status: pinned.kind, fingerprint: fingerprintText(pinned.fingerprint), fingerprint_sha256: pinned.fingerprint, previous: pinned.previous === null ? null : fingerprintText(pinned.previous), team: pinned.team, signers: pinned.signers, machine: { id: pinned.machine.id, name: pinned.machine.name } })}\n`);
      return 'done';
    }
    const said = pinned.kind === 'same'
      ? `owner seat: owner@${pinned.team} is pinned already with this fingerprint; nothing changed`
      : pinned.kind === 'repinned'
        ? `owner seat: owner@${pinned.team} pinned again, from an export signed by a signer pinned here (was ${fingerprintText(pinned.previous!)})`
        : `owner seat: owner@${pinned.team} pinned from another machine (trust on first use: this machine believes the first export its owner gives it)`;
    const kept = pinned.place === 'system'
      ? 'the pin is kept in the system owner folder: every account of this machine reads it, and only the administrator changes it'
      : "note: the pin is kept in this account's config folder, where a process of the account can still replace it, until a separate account keeps it";
    io.stdout(`${said}\nfingerprint: ${fingerprintText(pinned.fingerprint)}; compare it with the one the export printed\nthis machine: ${pinned.machine.name} (${pinned.machine.id}); signers: ${pinned.signers.join(', ')}\nfrom now on a terminal on this machine is not the owner: an owner-only action runs on the owner's signed answer, carried as files from the machine that holds the signers\n${kept}\n`);
    return 'done';
  }

  if (sub === 'setup') {
    if (args.values.team === undefined || args.values.signer === undefined) return refuse('setup needs --team <team> and --signer <name>', 'invocation');
    const made = registerOwnerSeat(home, { team: args.values.team, signer: args.values.signer, ...(args.values.entity !== undefined ? { entity: args.values.entity } : {}) }, store, now());
    if (!made.ok) return refuse(made.why);
    // The owner's presence confirms the seat: one Touch ID (or login password) on this Mac. An
    // agent can create a Secure Enclave key, but only the owner can make it sign.
    // The same Touch ID also covers the entity policies named here, so setup is one owner act.
    const signer = made.record.signers[0]!;
    const policies: Array<{ name: string; value: unknown }> = [];
    if (args.values['owner-signers'] !== undefined) policies.push({ name: 'owner-signers', value: args.values['owner-signers'].split(',').map((n) => n.trim()).filter(Boolean) });
    if (args.values['grant-emission'] !== undefined) policies.push({ name: 'grant-emission', value: args.values['grant-emission'] });
    const policyEntities = [...new Set((args.values['policy-entity'] ?? made.record.entity).split(',').map((e) => e.trim()).filter(Boolean))];
    const policyEntity = policyEntities.join(', ');
    const said = policies.length === 0 ? '' : ` and set ${policies.map((p) => `${p.name}=${Array.isArray(p.value) ? p.value.join(',') : String(p.value)}`).join(', ')} for ${policyEntities.length === 1 ? 'entity' : 'entities'} ${policyEntity}`;
    const statement = Buffer.from(`team-owner-seat-setup-v1\n${JSON.stringify({ team: made.record.team, public_key: signer.public_key, entities: policyEntities, policies })}`, 'utf8');
    const confirmed = store.sign(signer.label, statement, `Create the TeamCLI owner seat for ${made.record.team}${said}`);
    const statementOk = confirmed.ok && (() => {
      const key = ownerSeatPublicKey(signer.public_key);
      try {
        return key !== null && cryptoVerify('sha256', statement, { key, dsaEncoding: 'der' }, Buffer.from(confirmed.signature, 'hex'));
      } catch {
        return false;
      }
    })();
    if (!confirmed.ok || !statementOk) {
      renameSync(ownerSeatFile(home), `${ownerSeatFile(home)}.unconfirmed-${now().getTime()}`);
      const why = confirmed.ok ? 'the confirmation signature does not verify under the new key' : confirmed.why;
      audit(home, 'seat-unconfirmed', { team: made.record.team, why }, now());
      return refuse(`the owner did not confirm the seat (${why}); nothing is registered`);
    }
    audit(home, 'seat-registered', { team: made.record.team, signer: signer.name, policies }, now());
    for (const p of policies) {
      for (const target of policyEntities) {
        const wrote = writePolicySet(home, { level: 'entity', target, name: p.name, value: p.value } as never, { now: now() });
        if (!wrote.ok) return refuse(`seat registered, but policy ${p.name} was not set for ${target} (${wrote.why})`);
        io.stdout(`policy: entity ${target} ${p.name} set\n`);
      }
    }
    io.stdout(`owner seat: registered owner@${made.record.team}, confirmed by Touch ID\nsigner: ${signer.name} (Secure Enclave)\n`);
    return 'done';
  }

  if (sub === 'profile') {
    const word = args.rest[1];
    const name = word === 'strict' || word === 'relaxed' || word === 'dev' ? profileNameOf(word) : null;
    if (name === null) return refuse('profile is strict, relaxed or dev', 'invocation');
    const days = args.values.days === undefined ? 7 : Number(args.values.days.replace(/d$/, ''));
    const proposed = proposeSecurityProfile(home, { profile: name, days, reason: args.values.reason ?? `${name} profile`, ...(args.values.signer !== undefined ? { signer: args.values.signer } : {}) }, now());
    if (!proposed.ok) return refuse(proposed.why);
    const seat = readOwnerSeat(home)!;
    const signer = seat.signers.find((s) => s.name === proposed.body.signer)!;
    if (signer.type === 'webauthn') {
      io.stdout(`security profile ${name} until ${proposed.body.expires} proposed for passkey "${signer.name}"\nthe owner signs it on the owner page (team owner-seat serve), challenge ${proposed.challenge}\n`);
      return 'done';
    }
    const signed = signSecurityProfile(home, store, undefined, now());
    if (!signed.ok) return refuse(`the profile was not signed (${signed.why})`);
    io.stdout(`${securityProfileLine(readSecurityProfile(home, store, now()))}\n`);
    return 'done';
  }

  if (sub === 'serve') {
    // Every act on the page needs an owner signer, so with no seat there is nothing to serve.
    if (readOwnerSeat(home) === null) return refuse('no owner seat is registered yet: team owner-seat setup comes first');
    const page = await serveOwnerPage({ home, store, ...(args.values.port !== undefined ? { port: Number(args.values.port) } : {}), now });
    io.stdout(`owner page: ${page.url}\nopen it on this Mac; a passkey signature can use the iPhone through the browser's QR code. Ctrl-C stops it.\n`);
    if (options.serve === false) page.server.close();
    else await new Promise<void>((resolve) => page.server.on('close', () => resolve()));
    return 'done';
  }
  return refuse(`unknown subcommand "${String(sub)}"\n${USAGE}`, 'invocation');
}
