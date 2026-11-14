// The owner helper's program on a machine whose accounts share one owner: one spend on stdin, one
// verdict on stdout (src/client/owner-spend.ts). `team owner-seat install` bundles this file into
// the administrator's own folder, and the system's privilege rule starts it, through its
// launcher, as the helper's user. Its input is read with a size cap and a deadline.
import { passwdNameOf, readCappedInput, runOwnerSpend, verdictLine, type SpendVerdict } from './owner-spend.ts';

const input = await readCappedInput(Bun.stdin.stream());
const verdict: SpendVerdict = input.ok
  ? runOwnerSpend({
    stdin: input.text,
    env: { SUDO_UID: process.env.TEAMCLI_CALLER_UID, SUDO_USER: process.env.TEAMCLI_CALLER_USER },
    uid: process.getuid?.() ?? -1,
    now: new Date(),
    nameOf: (uid) => passwdNameOf(uid),
  })
  : input;
process.stdout.write(verdictLine(verdict), () => process.exit(verdict.ok ? 0 : 1));
