import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { hostedCommit } from '../host/request-scope.ts';

// A desktop notification, best effort: a machine without one still has the log.
export function notify(text: string, title = 'Team watch'): void {
  try {
    if (platform() === 'darwin') {
      const quote = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;
      hostedCommit('node:child_process.execFileSync');
      execFileSync('osascript', ['-e', `display notification ${quote(text)} with title ${quote(title)}`], { stdio: 'ignore', timeout: 5000 });
    } else {
      hostedCommit('node:child_process.execFileSync');
      execFileSync('notify-send', [title, text], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
}
