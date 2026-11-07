// The handover path, one shape for every asker. The swap queue mints it when a swap cannot carry
// the conversation; the checkpoint (context reset R2) mints the same shape at a task boundary.
// One layout in one folder, so a handovers directory holds files any reader can name and a seat
// told one path is never told another for the same instant.
import { join } from 'node:path';

/** The path a handover is written at: the project's `handovers` folder, named for the seat and
 *  the asking instant. A queued record or checkpoint keeps the path, so a run retried after a
 *  busy turn looks for the same file and a retry never types over one already written. */
export function handoverPath(dir: string, seat: string, now: Date): string {
  return join(dir, 'handovers', `${seat}-${now.toISOString().replace(/[:.]/g, '-')}.md`);
}
