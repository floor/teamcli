// The restart this step starts, and the ready result it reads back. The arguments are the
// command's own: no `--fresh`, no `--abandon`, no `--resume`, and no handover path. The
// command reads the checkpoint that is on record. This step never asks for one.

export type RestartReady = {
  kind: 'ready';
  /** Set when a handover file was already at the recorded path and the launch was given it. */
  handover?: string;
  /** Set when a checkpoint is on record and no file was there. */
  handoverAsked?: string;
};

/** `team restart <seat> --json`. */
export function restartArgs(seat: string): readonly string[] {
  return ['restart', seat, '--json'];
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The ready document `team restart --json` writes. Anything else is not a ready restart.
 *  `handover` and `handoverAsked` are read when the command carries them. */
export function readRestartReady(stdout: string): RestartReady | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  const schema = doc.schema as { name?: unknown } | undefined;
  if (schema?.name !== 'team.restart') return null;
  if (doc.status !== 'ready') return null;
  const handover = textField(doc.handover);
  const asked = textField(doc.handoverAsked) ?? textField(doc.handover_asked);
  return {
    kind: 'ready',
    ...(handover === undefined ? {} : { handover }),
    ...(asked === undefined ? {} : { handoverAsked: asked }),
  };
}
