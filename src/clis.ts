// The CLIs version 0.1 knows. A seat's `cli` picks one; `processes` are the names its process
// runs under, which the caller check looks for among a command's ancestors.
export type Profile = { cli: string; processes: string[] };

export const PROFILES: Profile[] = [
  { cli: 'claude-code', processes: ['claude'] },
  { cli: 'codex', processes: ['codex'] },
  { cli: 'cursor', processes: ['cursor-agent'] },
  { cli: 'grok', processes: ['grok'] },
  { cli: 'antigravity', processes: ['agy'] },
  { cli: 'gemini', processes: ['gemini'] },
];

export const CLIS: string[] = PROFILES.map((profile) => profile.cli);

export const CLI_PROCESSES: string[] = PROFILES.flatMap((profile) => profile.processes);
