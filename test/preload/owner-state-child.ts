// For a CLI a scene starts as a child process (`bun --preload <this file> src/cli.ts …`): the
// suite's owner-state roots, as test/preload/team-config-source.ts sets them for in-process
// scenes. The child then reads its owner state in the home it is given and never the machine's
// own system folder — which, on Linux, would refuse every owner answer on a machine never set up.
// Only a test passes this file; no command line, variable or file of a real run reaches it.
import { installOwnerStateRootsForTests } from '../helpers/owner-state-roots.ts';

installOwnerStateRootsForTests();
