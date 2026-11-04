// The suite's tests were written against the team file: they keep reading it, through the one
// seam's `file` source, unless a test names the registry itself (test/file/team-config-registry.test.ts
// passes its own `env` and `source`). A user's machine reads the registry by default.
import { afterEach } from 'bun:test';

process.env.TEAM_CONFIG_SOURCE ??= 'file';
process.env.TEAM_NO_SYSTEM_TRASH ??= '1';
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
