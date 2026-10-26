// The suite's tests were written against the team file: they keep reading it, through the one
// seam's `file` source, unless a test names the registry itself (test/file/team-config-registry.test.ts
// passes its own `env` and `source`). A user's machine reads the registry by default.
process.env.TEAM_CONFIG_SOURCE ??= 'file';
