// The settings-file half of the Claude adapter: one turn event, staged under the launch's
// binding. The command is hidden — it is written into a seat's per-launch settings file, never
// typed by a person and never listed in the help text.
//
// Every word comes from argv, written there at install time. The hook reads nothing from the
// CLI's stdin, so a turn's prompt bytes never pass through this process, and it writes nothing
// but the seat's spool record: the daemon's ingester owns the log, the projection and the
// rejection folders. Arguments are revalidated here because a settings file is a file: the
// binding must be the launch's shape even if the text was edited.
//
// The function returns 0 after a refusal as it does after a stage. The command in the settings
// file also discards its output and ignores its exit, so a presence fault can never break the
// turn it observes; the honest record of a refused stage is the missing spool file.
import { isPresenceBinding, isPresenceEvent, type PresenceEvent } from './contract.ts';
import { stagePresenceRecord } from './spool.ts';

type Parsed = {
  dir: string;
  session: string;
  seat: string;
  binding: string;
  event: PresenceEvent;
};

const FLAGS = new Set(['--dir', '--session', '--seat', '--binding', '--event']);

function parse(argv: readonly string[]): Parsed | null {
  const found = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !FLAGS.has(flag) || found.has(flag)) return null;
    found.set(flag, value);
  }
  const dir = found.get('--dir');
  const session = found.get('--session');
  const seat = found.get('--seat');
  const binding = found.get('--binding');
  const event = found.get('--event');
  if (dir === undefined || dir === '' || session === undefined || session === '') return null;
  if (seat === undefined || seat === '') return null;
  if (binding === undefined || !isPresenceBinding(binding)) return null;
  if (event === undefined || !isPresenceEvent(event)) return null;
  return { dir, session, seat, binding, event };
}

export default function run(argv: readonly string[]): number {
  const parsed = parse(argv);
  if (parsed === null) return 1;
  const staged = stagePresenceRecord(parsed.dir, {
    session: parsed.session,
    seat: parsed.seat,
    binding: parsed.binding,
    source: 'runtime-hook',
    event: parsed.event,
  });
  return staged.kind === 'staged' ? 0 : 1;
}
