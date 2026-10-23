// Refuse setup before it writes shared policies an installed CLI cannot read.
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkInstalledPolicies(binary, signer) {
  const entry = realpathSync(binary);
  const { getPolicySpec } = await import(pathToFileURL(join(dirname(entry), 'policy/types.js')).href);
  for (const [name, value] of [['owner-signers', [signer]], ['grant-emission', 'conversational']]) {
    const spec = getPolicySpec(name);
    if (!spec || spec.kind !== 'enforced' || !spec.levels.includes('entity') || spec.parseValue(value) === null) {
      throw new Error(`installed team does not support ${name}; install the matching catalogue before owner setup`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkInstalledPolicies(process.argv[2], process.argv[3] ?? 'mac');
    console.log('installed team supports owner-signers and grant-emission');
  } catch (error) {
    console.error(`owner setup refused: ${error.message}`);
    process.exitCode = 1;
  }
}
