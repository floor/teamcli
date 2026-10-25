# herdr

`team` runs a team inside [herdr](https://herdr.dev). herdr is the terminal server a team lives
in: a named **session**, the **workspaces** in it, each with its **tabs** and its **panes**, and
the integrations through which a pane says what it is running. `team` owns none of that and is a
client of it — every `herdr` process the build starts comes from `src/herdr.ts` (the live scripts
under `test/` drive scratch sessions of their own), every call that works inside a session carries
`--session <name>`, and what a command does to a team is one of the calls below.

This page is herdr as `team` uses it: the objects, the calls, and which part of a team makes each.
The transcripts are runs against **herdr 0.7.1** — the version this build is run with
(`src/herdr.ts`'s `HERDR_TESTED`; `team doctor` reads `herdr --version` and names it), in a scratch
session of the author's, whose own name reads as `beacon` below. They are quoted as they printed:
`…` marks text left out of a long line, and `~` stands for this machine's home folder. They are evidence, not fixtures — `bun run ci`
executes the examples of the [command pages](../commands/README.md), and nothing on this page.

## The session

A session is a name, a folder under `~/.config/herdr/sessions/<name>` and a socket in that folder,
and one server answers it. It runs headless:

    $ herdr --version
    herdr 0.7.1

    $ herdr --session beacon session list --json
    {"sessions":[{"default":true,"name":"default","running":false, …},
                 {"default":false,"name":"beacon","running":true,
                  "session_dir":"~/.config/herdr/sessions/beacon",
                  "socket_path":"~/.config/herdr/sessions/beacon/herdr.sock"}, …]}

    $ herdr --session beacon server           # a headless server, until it is stopped

`herdr --help` names the groups — `session`, `workspace`, `worktree`, `tab`, `notification`,
`agent`, `pane`, `wait`, `integration`, `config`, `channel` — and the rest: `herdr status`,
`herdr update`, `herdr server stop`, `herdr server reload-config`, `herdr channel set`, and
`herdr session attach <name>`. A command addressed to a session whose server is not running gets
the connection's own refusal (`Error: Os { code: 61, kind: ConnectionRefused, … }`), which is what
`team doctor` reports as herdr not answering.

The team file names the session (`session:`, defaulting to `<entity>-<project>` when the file names
an entity and to the project's name when it does not), and it is never herdr's own `default`
session; that one is the only session a call of `team`'s aims at with no flag. The session's own calls name it in their arguments instead: `server`, `list`, `stop` and
`delete`. `team` starts a server only when the session is absent — a second server for one that is
already running has been seen to drop it (`src/herdr.ts`) — and `add` refuses a session that is
stopped, naming the clear: `` clear it with `herdr session delete <name>` ``. `up` clears a stopped
session this team's state records and goes on, and refuses one it does not record with
`session <name> is stopped`. Stopping is `down`'s:

    $ herdr --session beacon session stop beacon
    stopped session beacon

Stopped is not gone: the session stays listed, `"running":false` (as above), and a call that needs
its server is refused until one is started. `session delete` is what clears it — it works on a
stopped session with that server down — and `team` counts a clear only on herdr's exact answer:

    $ herdr --session beacon session delete beacon
    deleted session beacon

Clearing happens on either side: `down` clears the session it has itself just stopped, in the same
run, and `up` clears a stopped session before it starts a fresh one. `team` never attaches:
`herdr session attach <name>` is the person's move — herdr's own help answers
`herdr session attach --help` with `usage: herdr session attach <name>` — and nothing in this tree
calls it, so a seat works in its pane whether or not a terminal is attached to the session.

## Workspaces, tabs and panes

Ids are minted by the session: `w1` is a workspace, `w1:t1` a tab, `w1:p1` a pane, and a pane also
carries a `terminal_id`. One call makes a workspace and its root pane together:

    $ herdr --session beacon workspace create --cwd /tmp/herdr-doc-run --label doc-probe --no-focus
    {"id":"cli:workspace:create","result":{"root_pane":{"agent_status":"unknown","cwd":"/private/tmp/herdr-doc-run","focused":true,"foreground_cwd":"/private/tmp/herdr-doc-run","pane_id":"w1:p1","revision":0,"tab_id":"w1:t1","terminal_id":"term_65dd524e493981","workspace_id":"w1"},"tab":{"agent_status":"unknown","focused":true,"label":"1","number":1,"pane_count":1,"tab_id":"w1:t1","workspace_id":"w1"},"type":"workspace_created","workspace":{"active_tab_id":"w1:t1","agent_status":"unknown","focused":true,"label":"doc-probe","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w1"}}}

    $ herdr --session beacon pane list --workspace w1
    {"id":"cli:pane:list","result":{"panes":[{"agent_status":"unknown","cwd":"/private/tmp/herdr-doc-run","focused":true,"foreground_cwd":"/private/tmp/herdr-doc-run","pane_id":"w1:p1","revision":0,"tab_id":"w1:t1","terminal_id":"term_65dd524e493981","workspace_id":"w1"}],"type":"pane_list"}}

`--label` is the workspace's name, and it can be rewritten while the team runs: it is the first of
the two names a seat shows, written from the seat's label and re-written when the file's label
changes.

    $ herdr --session beacon workspace rename w1 coordinator
    {"id":"cli:workspace:rename","result":{"type":"workspace_info","workspace":{"active_tab_id":"w1:t1","agent_status":"idle","focused":true,"label":"coordinator","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w1"}}}

    $ herdr --session beacon workspace list
    {"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[{"active_tab_id":"w1:t1","agent_status":"idle","focused":true,"label":"coordinator","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w1"}]}}

    $ herdr --session beacon workspace close w1
    {"id":"cli:workspace:close","result":{"type":"ok"}}

    $ herdr --session beacon workspace list
    {"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[]}}

A pane's processes are what tells `team` whether the seat it launched is still the process in the
pane:

    $ herdr --session beacon pane process-info --pane w1:p1
    {"id":"cli:pane:process_info","result":{"process_info":{"foreground_process_group_id":6740,"foreground_processes":[{"argv":["-zsh"],"argv0":"zsh","cmdline":"-zsh","cwd":"/private/tmp/herdr-doc-run","name":"zsh","pid":6740}],"pane_id":"w1:p1","shell_pid":6740},"type":"pane_process_info"}}

`shell_pid` is the pane's shell, `foreground_processes` what stands in front of it, and a pane
whose shell has come back with no seat's CLI in front of it reads as a seat that has exited. This
is how the caller gate and the seat checks behind the launch, `down`, `remove`, `answer`, `status`,
`check` and `send` tell a pane that still holds the seat they are about to act on from one that
does not, and why a launch records the pids it left in the pane (`src/state.ts`).

## Reading a pane

A pane's screen is read, never inferred:

    $ herdr --session beacon pane run w1:p1 'echo hello-from-team'      # prints nothing, exit 0
    $ herdr --session beacon pane read w1:p1 --source visible --lines 10
    ❯ echo hello-from-team
    hello-from-team
    /private/tmp/herdr-doc-run                  01:18:14
    ❯

`pane run` types the command into the pane and sends it. `pane read --source visible` returns the
screen; `--lines <n>` bounds it, `--format ansi` asks for the styling, and `--source recent`
returned nothing more than the visible screen on this headless server. `team` reads the window a
launch's idle wait, the watch, `status`, `check`, `doctor`, `down`, `answer` and `send` all work
from — the last 14 lines (`src/herdr.ts`'s `PANE_WINDOW`) — asking for the styled form and falling
back to the plain one for an herdr that refuses that flag. `team` never runs herdr's own blocking
`wait` calls: it reads the screen on its own clock. herdr has them all the same:

    $ herdr --session beacon wait output w1:p1 --match hello-from-team --timeout 3000
    {"id":"cli:wait:output","result":{"matched_line":"❯ echo hello-from-team","pane_id":"w1:p1", … "type":"output_matched"}}

Text can also be typed without being run:

    $ herdr --session beacon pane send-text w1:p1 'echo typed-by-send-text'   # literal, no Enter
    $ herdr --session beacon pane send-keys w1:p1 enter
    $ herdr --session beacon pane read w1:p1 --source visible --lines 6
    ❯ echo hello-from-team
    hello-from-team
    ❯ echo typed-by-send-text
    typed-by-send-text
    /private/tmp/herdr-doc-run                  01:18:37
    ❯

`send-text` is literal and sends no Enter; `send-keys` takes one key by name. `team` uses the pair
where a key must be pressed and the text is not a shell command — the launch, `down` and `remove`
for a seat's exit and for a box that holds text an earlier run left, the watch's nudge, and
`team answer <seat> trust`, which presses the one recorded key and nothing else. `pane run` is the
other extreme: a whole command, sent. It is what starts a seat and the watch in its own workspace
alike. A seat's
exit is not one: a plan prints that step as a `pane run` line, but the live move types the exit
into the seat's idle prompt and reads the screen again before the key — `/exit` has to reach the
prompt, not the line the screen held before (`src/launch/plan.ts`).

## The second name a seat shows: the display line

Each seat's pane is given a `display_agent` — the file's `display` and `effort`
(`Claude Opus 5.5 default`), or the display alone when its CLI takes no effort setting
(`Jules 0.1.42`) — and a pane that a CLI has not identified is in no agent list at all:

    $ herdr --session beacon agent list
    {"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}

    $ herdr --session beacon pane report-metadata w1:p1 --source team --display-agent 'Claude Opus 5.5 default'
    (no output, exit 0)

`report-metadata` carries the id of the source that is reporting — `team`, for everything `team`
reports — and writes the pane's `display_agent`. The watch repaints it while a seat runs: the
display off the screen when the pane names a different model or effort than the file does, the
file's own otherwise, and only when the line changed since the last pass (`src/watch/pass.ts`). A
report that fails is one line on the watch's own output — `${seat}: its display was not reported` —
and changes nothing else: nothing is typed, no seat is stopped, and the pass goes on. `up` paints
both lines for a seat it launches, and repaints them for a seat that is already ready
(`src/launch/plan.ts`), which is what gives a seat started before the labels existed its name back.

## The agent a pane reports

A pane's agent is what a CLI reports through herdr's integration, not what its window looks like.
After the seat's CLI reports it, `agent list` carries it, with three different strings in play:

    $ herdr --session beacon agent list
    {"id":"cli:agent:list","result":{"agents":[{"agent":"doc-probe","agent_status":"idle","cwd":"/private/tmp/herdr-doc-run","display_agent":"Claude Opus 5.5 default","focused":true,"foreground_cwd":"/private/tmp/herdr-doc-run","pane_id":"w1:p1","revision":0,"tab_id":"w1:t1","terminal_id":"term_65dd524e493981","workspace_id":"w1"}],"type":"agent_list"}}

    $ herdr --session beacon pane report-agent w1:p1 --source team --agent doc-probe --state idle
    (no output, exit 0)

    $ herdr --session beacon agent rename w1:p1 claude-keeper
    {"id":"cli:agent:rename","result":{"agent":{"agent":"doc-probe","agent_status":"idle","cwd":"/private/tmp/herdr-doc-run","display_agent":"Claude Opus 5.5 default","focused":true,"foreground_cwd":"/private/tmp/herdr-doc-run","name":"claude-keeper","pane_id":"w1:p1","revision":0,"tab_id":"w1:t1","terminal_id":"term_65dd524e493981","workspace_id":"w1"},"type":"agent_info"}}

So one agent carries `agent` (the label the CLI reported), `name` (what `agent rename` wrote) and
`display_agent` (the line beside the workspace's), beside `agent_status` — the word `team` reads to
know whether a seat is idle, working or blocked. `agent rename` is how a pane becomes answerable by
a seat's own name: a launch renames the pane to the seat's name once herdr lists it as an agent
(`src/launch/execute.ts`), `answer` renames a seat back to it after answering a dialog when the
CLI's own report took the name away, and `team remove` renames a pane it leaves behind out of that
name, so no running pane answers to it (`src/commands/remove.ts`). herdr's own targets accept
terminal ids, unique agent names, reported agent labels and pane ids, which is why a call names a
recorded pane where the state has one and lets a person name the seat.

`agent focus <target>` brings a pane to the front and is the only move of its kind `team` makes: it
is what `up`'s pause offers as `o`, and the run sends no key and no text of its own into the pane.

## What each part of the team does with herdr

The launch below is `up`, `add` and the seat-launching module behind them.

| herdr call | Who makes it | Why |
| --- | --- | --- |
| `--session <name> server` | the launch, when the session is absent | to start the session, detached and with a clean environment |
| `session list` | `team list`, `doctor`, and every command that asks whether the session runs | the machine's sessions, and whether this one runs |
| `session stop` | `down`, once its seats are stopped | to stop the session |
| `session delete` | `down` (the session it has just stopped), `up` (a stopped one this state records) | to clear it |
| `workspace create --cwd --label --no-focus` | the launch, the watch | one workspace per seat, started in the seat's folder; `up` and a lone owner `watch` (on the team's own session, without `--no-nudge` or `--no-notify`) make the watch's too (`Watch · <project>`, in the project folder) |
| `workspace rename` | the launch (a seat already ready), the watch | the seat's label, and the label a file edit moved |
| `workspace close` | the launch (on `down`'s, `remove`'s, `up`'s and `add`'s behalf), the watch | a workspace a run is finished with, or a watch workspace whose command did not start |
| `workspace list`, `pane list --workspace` | `doctor`, `status`, `check`, the launch, the watch | the session's workspaces, and the panes in one |
| `pane process-info` | the caller gate, and the seat checks behind the launch, `down`, `remove`, `answer`, `status`, `check`, `send`, the watch | the pane's shell and foreground processes: the seat `team` launched, or not, and the pane the watch runs in |
| `pane get` | `down`, `remove`, `answer` | the folder a pane's foreground program works in, matched against the line the shell's prompt prints |
| `pane read --source visible` | the launch's idle wait, the watch, `doctor`, `status`, `check`, `down`, `answer`, `send` | the screen: an idle prompt, a dialog, a seat's exit question |
| `pane run` | the launch (a seat's launch line; `up` also runs the watch's own line), the watch (its own line, when started alone) | a whole command, typed and sent |
| `pane send-text`, `pane send-keys` | the launch, `down`, `remove`, the watch, `answer`, `send` | one key, or text with no Enter of its own |
| `pane report-metadata --source team --display-agent` | the launch, the watch | the seat's display line |
| `agent list` | the caller gate, the launch, `down`, `status`, `check`, `doctor`, `answer`, `send`, `team list`, the watch | which panes report an agent, and each one's status |
| `agent rename` | the launch (the seat's name), `answer` (back to it), `remove` (out of it) | so a pane answers to the seat's name, or stops answering to it |
| `agent focus` | `up`'s pause, on the owner's `o` | to bring a seat's pane up; nothing is typed |
| `--version` | `doctor` | the version, against the range this build was run with |

`team` never runs a `tab`, `worktree`, `notification`, `integration`, `config` or `channel`
subcommand, never herdr's blocking `wait` calls, and never `session attach`. A seat's pane is where
the seat works; herdr's own window is where the person watches it.
