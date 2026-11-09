# Direct preset swap

`team swap <seat> <preset> [--dry-run] [--json]` installs a complete recipe and restarts that seat once, with a fresh conversation even when the CLI stays the same. The older listing, queue, now, cancel and run forms keep their behavior.

A placed lead or operator acts only on its own team. The orchestrator seat remains the owner's. An owner charter, an entity model rule, unreadable policy, a protected folder or a full worktree limit can refuse the move before the seat is stopped.

A preset lives in `.agents/launchers/<name>.yaml`. Its `harness` supplies the CLI, its arguments supply the launch, and its `seat` map names `vendor`, `model`, `version` and `display`. The display must contain the exact version as a separate token. For example:

```yaml
format: 1
name: grok-builder
kind: preset
harness: grok
args: [--model, grok-4.7]
writable_folders: [{path: '{root}'}]
seat:
  vendor: xai
  model: Grok
  version: '4.7'
  display: Grok 4.7
```

A declared seat's name can also supply a complete recipe. Its model fields and launch are copied; its role, authority and start folder are never copied. An existing launcher of that name takes precedence. A missing or invalid recipe refuses without changes. Presets with unresolved secret references, settings layers, a scrubbed environment or a resume selection refuse rather than discard those requirements; a complete declared-seat recipe retains its existing launch line.

Grok and Cursor reuse an accepted own start folder or a recorded worktree. Otherwise swap creates a worktree using `workspace.path`, `workspace.branch`, `workspace.base` and a free `workspace.limit` slot, with task `swap-<seat>` and kind `swap`. It checks trust and protected folders, records the worktree for the seat, and never fetches, runs setup commands or deletes a peer's work. Returning to another CLI keeps the worktree. A team without an accepted worktree path must configure one first.

The dry run prints all model and placement fields, a planned worktree and the fresh restart, without creating folders, remembering configuration, writing state, stopping or starting a seat. The actual restart uses the same preflight and stop/launch path as restart, and writes the complete seat row atomically after stopping and before launch. A changed team record refuses the stale write. Worktree creation is bounded to eight seconds; CLI startup uses the profile's normal readiness wait.

A quota-wall or provider-error pane is treated as broken by the shared restart engine: it closes the stuck workspace without typing into it. A restart refusal before the new declaration is written rolls back this invocation's clean worktree, branch and slot. An existing worktree is retained. Unexpected edits, a moved branch or a changed worktree record prevent rollback and are reported for inspection; nothing is forcibly deleted. Once the new declaration has been accepted, a later startup failure keeps its worktree so that the new recipe can be retried.
