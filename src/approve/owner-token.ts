// A fingerprint-bound owner authorization, carried out of band so an authorized agent can run
// `team approve` and `team up` for the owner — and only for the exact change the owner saw. The
// sovereign guard is unchanged: the token admits a non-owner caller only when it equals the
// fingerprint the run recomputes NOW from the live source, so a post-yes edit diverges and is
// refused, and the owner's "yes <fingerprint>" can never leak to another change. The signing is
// untouched — the owner path signs with `keyOf(home)`, never a forged or new key.
//
// This is a minimal, throwaway gate pending the kernel rewrite.
import { createHash } from 'node:crypto';
import { canonical, fingerprints, type Approvable, type Fingerprints } from './fingerprint.ts';

/** The env var the out-of-band token is carried in. An env var, not a CLI flag: a flag could be a
 *  stray shell-history or pasted line, while an env var set for the one run is a deliberate act. */
export const OWNER_APPROVAL_ENV = 'TEAM_OWNER_APPROVAL';

/** The fingerprint hex the owner authorizes for an `approve`: the digest of the live file's
 *  owner-section and seat fingerprints — the same bytes `approve --show` prints — recomputed now,
 *  so any edit after the owner's yes gives a different hex and the token no longer matches. */
export function approveFingerprint(team: Approvable): string {
  return createHash('sha256').update(`approve\n${canonical(fingerprints(team))}`).digest('hex');
}

/** The fingerprint hex the owner authorizes for an `up`: the approved record's fingerprints and
 *  the generation it carries — what `up` would launch — recomputed now from the live standing. */
export function upFingerprint(approved: Fingerprints, generation: number): string {
  return createHash('sha256').update(`up\n${canonical({ fingerprints: approved, generation })}`).digest('hex');
}

/** Whether an out-of-band owner token authorizes exactly this change: true only when the env var
 *  holds, trimmed, the fingerprint the run recomputed now. Absent or empty is false — the owner
 *  gate's behaviour is unchanged when no token is set — and a token for any other change (a
 *  mutated file recomputes to a different fingerprint) never matches. */
export function ownerAuthorized(env: Record<string, string | undefined>, expectedFingerprint: string): boolean {
  const token = env[OWNER_APPROVAL_ENV]?.trim();
  return token !== undefined && token.length > 0 && token === expectedFingerprint;
}
