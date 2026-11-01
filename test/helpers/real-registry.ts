// The real machine's registry folder as this test process found it. The suite's preload imports
// this module first, so the reading is taken before any scene runs, whichever file asks later.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REAL_REGISTRY = join(homedir(), '.config', 'team', 'team-config');

/** The names in the real registry folder, or null when the folder is absent. A scene's team is
 *  a fresh temp checkout, so a scene that wrote here would add a record under a new name. The
 *  owner's own teams may be rewritten by their live seats while the suite runs, so a record's
 *  contents are not part of the reading. */
function registryFingerprint(): string | null {
  if (!existsSync(REAL_REGISTRY)) return null;
  return readdirSync(REAL_REGISTRY).sort().join('\n');
}

/** The real registry as this test process found it. An owner's machine may already hold one. */
const REAL_REGISTRY_AT_START = registryFingerprint();

/** The real machine's registry folder: a scene that created it, or added or removed a record in
 *  it, is a broken scene. A registry the machine already held is not a touch. */
export function realRegistryTouched(): boolean {
  return registryFingerprint() !== REAL_REGISTRY_AT_START;
}
