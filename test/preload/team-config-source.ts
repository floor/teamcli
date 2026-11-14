// The suite's tests were written against the team file: they keep reading it, through the one
// seam's `file` source, unless a test names the registry itself (test/file/team-config-registry.test.ts
// passes its own `env` and `source`). A user's machine reads the registry by default.
import { afterEach } from 'bun:test';

process.env.TEAM_CONFIG_SOURCE ??= 'file';
process.env.TEAM_NO_SYSTEM_TRASH ??= '1';
// The seats' generated settings files live under TeamCLI's machine folder in real use. The older
// scenes build their path by hand in the project state folder, so the suite keeps that layout
// (`project`); test/cli-hook-home.test.ts covers the machine folder itself. No scene writes
// into the real home.
process.env.TEAM_HOOKS_HOME ??= 'project';
// The same for the rules: the older scenes compare lines that carry the rules' whole text;
// test/rules-text-file.test.ts covers the file the launch names in real use.
process.env.TEAM_RULES_INLINE ??= '1';
// `hostConfigPath` is the only source path that reads an `XDG_*` base variable (`XDG_CONFIG_HOME`).
// Clearing it at preload and after each test keeps an ambient or per-test `XDG_CONFIG_HOME` from
// redirecting scratch-home scenes to a shared or live terminal-host config file; a test that
// exercises XDG resolution sets `process.env.XDG_CONFIG_HOME` itself.
delete process.env.XDG_CONFIG_HOME;
afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
});
// The real registry is read once, before any scene: a scene that wrote there is then caught by
// realRegistryTouched(), whichever test file asks.
import '../helpers/real-registry.ts';
// The owner-state resolver (src/client/owner-pin-path.ts) reads the account's own home and a
// system folder in real use, whatever home a command is given. Each scene keeps its owner state
// in the home it passes instead, and no scene reads the real account or the system folder, so
// pinning the machine the suite runs on changes no scene. test/owner-state-resolver.test.ts
// covers the real roots' rules with roots of its own.
import { ownerStateRootsForTests } from '../../src/client/owner-pin-path.ts';
export const SUITE_OWNER_STATE_ROOTS = {
  system: null,
  account: (given: string | undefined) => (given === undefined ? 'none' as const : { home: given }),
  systemOwner: process.getuid?.() ?? 0,
};
ownerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
afterEach(() => {
  ownerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
});
