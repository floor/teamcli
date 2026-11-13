// The one credential seam of `team release check` and `team broker`: the Keychain lookup the
// Linear check is built on. The lookup itself is the secret store's Keychain adapter
// (src/secrets/store-darwin.ts); this file is the contract's shape around it. The read is injected
// everywhere it matters — production wires the real facility through `realSecurityRun`, and no
// test ever runs it. The service name is the only argument the system tool ever sees; the key is
// taken from its standard output, is never echoed, is never an argument, an environment variable
// or input to any process, and reaches exactly one place: the Authorization header of the single
// Linear request (src/release/checks.ts).
import { keyOf, type KeyResult, type SecurityRun } from '../secrets/store-darwin.ts';

export { KEYCHAIN_TIMEOUT_MS, keyOf, realSecurityRun, type KeyResult, type SecurityRun } from '../secrets/store-darwin.ts';

/** The key reader the command receives: a service name in, a key or a generic failure out. */
export type KeyReader = (service: string) => Promise<KeyResult>;

/**
 * The Keychain read as the contract shapes it: the macOS facility only (no substitute store on
 * other platforms), only in an interactive run, and only when the command calls it — at most
 * once per command, after every non-secret prerequisite is known. The output's key is validated
 * before anything is built from it.
 */
export function keychainReader(platform: string, interactive: boolean, runSecurity: SecurityRun): KeyReader {
  return async (service) => {
    if (platform !== 'darwin') return { ok: false, reason: 'this platform has no such facility' };
    if (!interactive) return { ok: false, reason: 'the run is not interactive' };
    const out = await runSecurity(service);
    if (!out.ok) return { ok: false, reason: 'the lookup failed' };
    return keyOf(out.stdout);
  };
}
