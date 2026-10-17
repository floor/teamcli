// A profile module that drives a typed delivery: the screens between a CLI's idle prompt and
// its own submit, for a CLI whose drop-file trigger has nowhere to land. The CLI's TUI creates
// its work item from its own screens — a menu, a repo chooser, a task box, a confirm — so the
// module walks them, types the message where the CLI expects it, and returns the line the CLI
// printed as proof. The module is trusted package code, like a `screen_module`.

/** The seat's own folder and what its CLI lists: which repo a message belongs to. The caller
 *  fills it before the module runs — the folder from the pane's foreground cwd, the repo from
 *  that folder's git origin, the repos from the CLI's own listing. */
export type ComposeSeat = {
  /** The folder the pane works in. */
  cwd: string;
  /** The folder's own repo, `owner/repo` from its git origin, or null when it has none. */
  repo: string | null;
  /** The repos the CLI lists for this account, in the CLI's own order, or null when the CLI
   *  could not be asked. */
  repos: readonly string[] | null;
};

/** What a compose module may do to the pane. Nothing else is offered: no locks, no records. */
export type ComposeIo = {
  /** The pane's visible text, plain, or null when it cannot be read. */
  text(): string | null;
  /** Type text into the pane. A line is typed whole; the caller presses Enter itself. */
  type(text: string): boolean;
  /** Press one key, spelled as herdr spells it (`escape`, `enter`, `down`, `up`, `ctrl+c`). */
  key(key: string): boolean;
  /** Wait a number of milliseconds. */
  wait(ms: number): Promise<void>;
  /** The profile's idle timeout in seconds: how long a screen may take to arrive. */
  idleTimeout: number;
  /** The seat's folder and the repos its CLI lists. */
  seat: ComposeSeat;
};

/** A typed delivery the module refused, with the one line that repairs it. */
export class ComposeError extends Error {
  readonly repair: string;
  /** True once the module has typed the message: the box may hold it, so the send is
   *  `not-submitted`, not a refusal that leaves the pane untouched. */
  readonly typed: boolean;
  constructor(message: string, repair: string, typed = false) {
    super(message);
    this.name = 'ComposeError';
    this.repair = repair;
    this.typed = typed;
  }
}

/**
 * A compose module as a profile carries it: the module specifier (for an error message) and its
 * `compose` export. `compose` resolves with the CLI's own evidence line that it took the
 * message, and throws ComposeError when it refused.
 */
export type ComposeProfile = {
  module: string;
  compose(io: ComposeIo, message: string): Promise<string>;
  /** The CLI arguments that list the account's repos, one `owner/repo` per line, or empty when
   *  the module needs no such list. The caller runs them with the profile's `binary`. */
  repos: readonly string[];
};
