// The settings-file half of the Claude adapter: one turn event, staged under the launch's
// binding. The command is hidden — it is written into a seat's per-launch settings file, never
// typed by a person and never listed in the help text.
//
// Every word comes from argv, written there at install time. The turn commands read nothing from
// the CLI's stdin, so a turn's prompt bytes never pass through this process. The one command that
// reads stdin is the notification filter: Claude Code hands a Notification hook its payload
// there, and only the exact measured pair — `hook_event_name` `Notification` with
// `notification_type` `permission_prompt` — stages `human-wait`; every other notification type
// declines and writes nothing. The settings entry carries no matcher, because no matcher was
// measured; the exact payload filter is the whole condition.
//
// The hook writes nothing but the seat's spool record: the daemon's ingester owns the log, the
// projection and the rejection folders. Arguments are revalidated here because a settings file
// is a file: the binding must be the launch's shape even if the text was edited.
//
// The function returns 0 after a refusal as it does after a stage. The command in the settings
// file also discards its output and ignores its exit, so a presence fault can never break the
// turn it observes; the honest record of a refused stage is the missing spool file.
import { readFileSync } from 'node:fs';
import { isPresenceBinding, isPresenceEvent, type PresenceEvent } from './contract.ts';
import { stagePresenceRecord } from './spool.ts';

/** The one notification type measured to mean a person is being waited on. The runtime's word is
 *  carried into the record as `raw`, so the log keeps the adapter's own vocabulary. */
const PERMISSION_PROMPT = 'permission_prompt';

type Parsed = {
  dir: string;
  session: string;
  seat: string;
  binding: string;
  event: PresenceEvent;
  /** Present only on the notification command: the payload must also match its fields. */
  notification?: typeof PERMISSION_PROMPT;
};

const FLAGS = new Set(['--dir', '--session', '--seat', '--binding', '--event', '--notification']);

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
  const notification = found.get('--notification');
  if (dir === undefined || dir === '' || session === undefined || session === '') return null;
  if (seat === undefined || seat === '') return null;
  if (binding === undefined || !isPresenceBinding(binding)) return null;
  if (event === undefined || !isPresenceEvent(event)) return null;
  // The filter and the event are one unit: `human-wait` is only ever staged from the measured
  // permission prompt, and the measured permission prompt is only ever `human-wait`.
  if (notification !== undefined && notification !== PERMISSION_PROMPT) return null;
  if (notification !== undefined && event !== 'human-wait') return null;
  if (notification === undefined && event === 'human-wait') return null;
  return { dir, session, seat, binding, event, ...(notification !== undefined ? { notification } : {}) };
}

/** The exact payload the runtime measured on this adapter: a JSON object naming the Notification
 *  hook and the permission prompt. Every other shape, type or extra read declines. */
function isPermissionPromptPayload(text: string): boolean {
  if (text.length > 65_536) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.hook_event_name === 'Notification' && record.notification_type === PERMISSION_PROMPT;
}

/** The CLI's payload buffer. A terminal never carries one, so the command declines without
 *  blocking on a read that would wait for a person's EOF. */
function readPayload(): string {
  if (process.stdin.isTTY === true) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export default function run(argv: readonly string[], readInput: () => string = readPayload): number {
  const parsed = parse(argv);
  // exit: team.presence-hook-invalid
  if (parsed === null) return 1;
  // exit: team.presence-hook-ignored
  if (parsed.notification !== undefined && !isPermissionPromptPayload(readInput())) return 0;
  const staged = stagePresenceRecord(parsed.dir, {
    session: parsed.session,
    seat: parsed.seat,
    binding: parsed.binding,
    source: 'runtime-hook',
    event: parsed.event,
    ...(parsed.notification !== undefined ? { raw: parsed.notification } : {}),
  });
  // exit: team.presence-hook-staged
  // exit: team.presence-hook-refused
  return staged.kind === 'staged' ? 0 : 1;
}
