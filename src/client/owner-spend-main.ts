// The owner helper's program on a machine whose accounts share one owner: one spend on stdin, one
// verdict on stdout (src/client/owner-spend.ts). `team owner-seat install` bundles this file into
// the administrator's own folder, and the system's privilege rule starts it, through its
// launcher, as the helper's user. Its input is read with a size cap and a deadline, and one
// spend runs at a time.
import { holdSpendLock } from './owner-spend-lock.ts';
import { OWNER_HELPER_HOME, OWNER_SPEND_INPUT_MS, OWNER_SPEND_OUTPUT_MS, passwdNameOf, readCappedInput, runOwnerSpend, verdictLine, type SpendVerdict } from './owner-spend.ts';

// One deadline for the whole call: reading the input, then waiting for the spend lock.
const started = Date.now();
const input = await readCappedInput(Bun.stdin.stream());
const verdict: SpendVerdict = input.ok
  ? runOwnerSpend({
    stdin: input.text,
    env: { SUDO_UID: process.env.TEAMCLI_CALLER_UID, SUDO_USER: process.env.TEAMCLI_CALLER_USER },
    uid: process.getuid?.() ?? -1,
    clock: () => new Date(),
    nameOf: (uid) => passwdNameOf(uid),
    lock: () => holdSpendLock(`${OWNER_HELPER_HOME}/spend.lock`, Math.max(0, OWNER_SPEND_INPUT_MS - (Date.now() - started))),
  })
  : input;
// The lock is given up already. A caller that never reads its output holds only this process,
// and only briefly: the write has its own short deadline, then the helper exits.
const status = verdict.ok ? 0 : 1;
setTimeout(() => process.exit(status), OWNER_SPEND_OUTPUT_MS);
process.stdout.write(verdictLine(verdict), () => process.exit(status));
