// Invisible provisioning of the owner-seat helper (the Secure Enclave keystore binary).
//
// The helper used to be a manual step: run `scripts/build-owner-seat-helper.sh` (or the morning
// script) from a git checkout, or `team owner-seat setup` refused with "build the helper: swiftc …".
// Now the first command that needs the owner seat builds it on its own, entirely at user level:
//
//   swiftc <package>/helpers/owner-seat-keystore.swift   (shipped in the npm package)
//   codesign --force --sign -                             (ad-hoc: no identity, no keychain dialog)
//   owner-seat-keystore selftest                          (no prompt: a throwaway enclave key)
//
// into `~/.config/team-owner-seat/` (0700) — never /usr/local, never sudo. A stamp file records the
// sha256 of the source it was built from, so a TeamCLI upgrade that changes the helper rebuilds it
// silently on next use. A helper without our stamp (a codesigned/provisioned build the owner
// installed with `--identity`) is never replaced.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_NAME = 'owner-seat-keystore.stamp.json';

export type ProvisionRunner = (cmd: string, args: string[]) => { status: number | null; stderr: string };

export type ProvisionOptions = {
  /** the helper source; defaults to the one shipped next to this package */
  source?: string;
  run?: ProvisionRunner;
  platform?: NodeJS.Platform;
};

export type ProvisionResult =
  | { ok: true; action: 'present' | 'built' | 'foreign' }
  | { ok: false; why: string };

const defaultRun: ProvisionRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
  return { status: r.error !== undefined ? null : r.status, stderr: r.error?.message ?? r.stderr ?? '' };
};

/** `helpers/owner-seat-keystore.swift` from src/client (dev) or dist/client (installed package). */
export function bundledHelperSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', '..', 'helpers', 'owner-seat-keystore.swift')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Makes sure an up-to-date helper sits at `helper`; builds it when missing or stale. Silent. */
export function ensureOwnerSeatHelper(helper: string, options: ProvisionOptions = {}): ProvisionResult {
  if ((options.platform ?? platform()) !== 'darwin') return { ok: false, why: 'the owner-seat helper needs macOS' };
  if (process.env.TEAMCLI_NO_HELPER_AUTOBUILD === '1') {
    return existsSync(helper) ? { ok: true, action: 'present' } : { ok: false, why: 'the owner-seat helper is missing and TEAMCLI_NO_HELPER_AUTOBUILD=1' };
  }
  const source = options.source ?? bundledHelperSource();
  const dir = dirname(helper);
  const stampPath = join(dir, STAMP_NAME);
  if (source === null) {
    return existsSync(helper) ? { ok: true, action: 'present' } : { ok: false, why: 'the owner-seat helper source is not in this TeamCLI install' };
  }
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (existsSync(helper)) {
    if (!existsSync(stampPath)) return { ok: true, action: 'foreign' }; // owner-built (e.g. codesigned): never touched
    try {
      if ((JSON.parse(readFileSync(stampPath, 'utf8')) as { source_sha256?: string }).source_sha256 === sha) return { ok: true, action: 'present' };
    } catch { /* unreadable stamp: rebuild */ }
  }
  const run = options.run ?? defaultRun;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const work = mkdtempSync(join(dir, '.build-'));
  const bin = join(work, 'owner-seat-keystore');
  const fail = (step: string, r: { status: number | null; stderr: string }): ProvisionResult => {
    spawnSync('/usr/bin/trash', [work]);
    return { ok: false, why: `could not prepare the owner-seat helper (${step}: ${r.stderr.trim() || `exit ${r.status}`}); install the Xcode Command Line Tools (xcode-select --install) and retry` };
  };
  let r = run('swiftc', ['-O', source, '-o', bin]);
  if (r.status !== 0) return fail('swiftc', r);
  r = run('codesign', ['--force', '--sign', '-', bin]);
  if (r.status !== 0) return fail('codesign', r);
  r = run(bin, ['selftest']);
  if (r.status !== 0) return fail('selftest', r);
  renameSync(bin, helper);
  writeFileSync(stampPath, `${JSON.stringify({ format: 1, source_sha256: sha, signing: 'adhoc', built_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  spawnSync('/usr/bin/trash', [work]);
  return { ok: true, action: 'built' };
}
