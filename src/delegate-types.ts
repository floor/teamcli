/**
 * A command an approved delegate pane may be allowed to run. `approve` is grantable like the
 * rest, under the gate's ordinary-change guard: a delegated approval admits a roster or
 * `rules` change and refuses, fail-closed, every other owner section — `delegates`,
 * `budgets`, `limits`, identity, `trust`, the workspace, and any section added later — so a
 * delegate can never approve a change to its own authority.
 */
export type DelegateCommand = 'up' | 'down' | 'add' | 'remove' | 'approve' | 'swap';

/** The six, in the order the documentation lists them. `swap` is not a command of its own: it is
 *  the word that admits `remove <lead> --keep` and `add <lead>` — the replacement of the agent on
 *  the orchestrator's or the operator's seat. `remove` alone never admits a lead. */
export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove', 'approve', 'swap'];

/** The words that are commands: every exit id the gate defines is one of these. */
export type ActingCommand = Exclude<DelegateCommand, 'swap'>;
export const ACTING_COMMANDS: readonly ActingCommand[] = ['up', 'down', 'add', 'remove', 'approve'];

/** One approved pane and the commands it may run. `pane` is `<herdr session>/<pane id>`. */
export type Delegate = { pane: string; commands: DelegateCommand[] };

/**
 * The file's `delegates` section: null when absent. A non-empty list, at most eight entries,
 * two entries naming one pane refused; each entry's commands a non-empty list of distinct ones.
 */
export type Delegates = Delegate[] | null;
