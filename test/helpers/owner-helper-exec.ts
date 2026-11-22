// The owner helper as the test suite starts it. src/client/owner-spend-exec.ts, which starts the
// real helper through the privilege rule, is replaced for the whole suite by the preload
// (test/preload/team-config-source.ts) with `execOwnerHelperInTests` below; a scene sets what the
// helper answers with `setOwnerHelperForTests`. No module of TeamCLI's own can do either.
type Exec = (stdin: string) => { status: number | null; stdout: string };

let current: Exec | null = null;

/** What the helper answers in this scene; `null`: no helper at all (no verdict). */
export function setOwnerHelperForTests(next: Exec | null): void {
  current = next;
}

export function execOwnerHelperInTests(stdin: string): { status: number | null; stdout: string } {
  return current === null ? { status: 1, stdout: '' } : current(stdin);
}
