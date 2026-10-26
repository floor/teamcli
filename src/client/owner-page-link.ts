// The owner page `team owner-seat serve` is already showing. A command that records a request
// must not open another browser window on top of it: the page polls, and the new card appears
// there. This file is the only place a request would open a window.

import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type OwnerPageLink = { pid: number; port: number; url: string };

export function ownerPageLinkPath(home: string): string {
  return join(home, '.config', 'team', 'owner-page.json');
}

export function writeOwnerPageLink(home: string, link: OwnerPageLink): void {
  const path = ownerPageLinkPath(home);
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(link)}\n`, { mode: 0o600 });
}

/** Drops the link when this serve is the one that wrote it. A newer serve is left in place. */
export function clearOwnerPageLink(home: string, link: OwnerPageLink): void {
  const current = readOwnerPageLink(home);
  if (current === null || current.pid !== link.pid || current.port !== link.port) return;
  try {
    unlinkSync(ownerPageLinkPath(home));
  } catch {}
}

export function readOwnerPageLink(home: string): OwnerPageLink | null {
  try {
    const path = ownerPageLinkPath(home);
    if (!lstatSync(path).isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerPageLink>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' || typeof parsed.url !== 'string') return null;
    return { pid: parsed.pid, port: parsed.port, url: parsed.url };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the recorded owner page's process is still running. */
export function ownerPageLive(home: string): boolean {
  const link = readOwnerPageLink(home);
  return link !== null && processAlive(link.pid);
}

/**
 * Tells the caller whether the owner page is already up. `open` is not called: a live page
 * shows the new card itself, and a request does not start a browser when no page is up
 * (`team owner-seat serve` is what opens it).
 */
export function presentOwnerRequest(home: string, open?: (url: string) => void): 'live' | 'closed' {
  if (ownerPageLive(home)) return 'live';
  void open;
  return 'closed';
}
