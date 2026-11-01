// Isolate environment and working-directory choices from the surrounding test process.
import * as helpers from '../helpers.ts';

const helper = (helpers as { fixtureBase?: (prefix: string) => string }).fixtureBase;
if (helper === undefined) {
  console.log(JSON.stringify({ available: false }));
} else {
  try {
    console.log(JSON.stringify({ available: true, path: helper(process.argv[2] ?? 'probe-') }));
  } catch (error) {
    console.log(JSON.stringify({ available: true, error: error instanceof Error ? error.message : String(error) }));
  }
}
