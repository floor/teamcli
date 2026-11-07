# Team Rename

Reference: project architecture §§1.3, 3b, 5.1, 5.4, 5.7, 5.10.

## 1. Synopsis & Admission

```text
team rename --team <new-name> [--from <old-name>] [--in-project <project>] [--session <name>] [--rekey] [--file <path>] [--dry-run] [--json]
```

Existing seat forms (`team rename <seat> <new-seat>` and `team rename --renumber`) are unchanged.

- **Admission (§5.1):** No new capability word and no create-grant or project-grant path. Admitted only by the owner, or by a seat holding `leads` on the team while `development_mode` is active for `'rename'`.
- **Dry-run parity (§5.10):** `--dry-run` executes the identical admission, root-move, name-collision, session-collision, and validation pipeline as the live run, reaching every refusal the real run would before touching disk, and prints (or emits via `--json`) the planned mutations. Both modes require an existing state directory, the existing owner signing key, and verified approval, and refuse moving a lobby claimed by another team (including the destination). Refusal and dry-run paths write no audit log, regenerate no key, and change no files. Nothing is applied to a live record without the owner; the motivating duplicate-name case serves only as the fixture shape.

## 2. Ids Are Keys & Root Moves (§1.3, §5.4)

A team's key is `teamIdOf(root)` (`sha256(realpath(root)).slice(0, 12)`).
- **Same-root rename:** `project:` (the team's own name) and optional project membership change in place. `teamId` never changes; `teams.yaml[<id>]` and `team-config/<id>.json` keep their key.
- **Root move (`recorded.root !== realRoot(root)`):** Never recomputed silently.
  - Without `--rekey`, `team rename --team` refuses, naming the recorded root/id (`<oldRoot>` / `<oldId>`), the current root/id (`<newRoot>` / `<newId>`), and the artifacts keyed by id (`teams.yaml`, `team-config/<id>.json`, `<project>-<hash>`, `projects.yaml`, `agents/*.yaml`, grants).
  - With `--rekey` (owner-only), `team rename` explicitly re-keys `teams.yaml[<oldId> → <newId>]`, `team-config/<oldId>.json → <newId>.json`, `<oldProject>-<oldId> → <newProject>-<newId>`, `projects.yaml` `teams[]`, `agents/*.yaml` (`reach.team`), and owner-signed grants naming `<oldId>`.

## 3. Project Membership Isolation

Project membership changes route through a single function:

```ts
setTeamProjectMembership(home: string, teamId: string, inProject: string | null, opts?: { entity?: string | null; by?: string; at?: string }): { projectId: string | null; projects: string[] }
```

This writes the display spelling to `in_project` in the team text, derives `projectIdOf(inProject)` for `projectId` / `projects: [...]` on `TeamRecord` (aligned with item 0's `project_id` home + `projects[]` list), and updates `projects.yaml` membership so item 0's schema lands at one seam.

## 4. What Carries Over

| Surface | Action on Rename (`<old>` → `<new>`, id `<hash>`) |
| --- | --- |
| **Team config** | `writeTeamText` updates `project: <new>`, optional `in_project: <project>`, and `session:` when `--session` is given. |
| **State folder** | Moves `~/.config/team/<old>-<hash>` → `~/.config/team/<new>-<hash>` first, carrying `messages.jsonl` (+ rotations), `sessions.jsonl`, `ledger.json`, `rules/`, `queue/`, `queues/`, `notes/`, `pending/`. |
| **Approval record** | After the state folder moves, `recordTeamRenameOf` updates `project` / `in_project` / `session` and re-fingerprints `session` and `grant` inside `approval.json` and `approved.yaml` when standing is `verified` and the live file matches, preserving standing without drift. |
| **Registry (`teams.yaml`)** | Updates `project`, `projectId`/`projects`, `session`, `lobby`, `lobbies`, and appends `{ name: <old>, until }` to `previousNames` (default 30-day grace window). |
| **Lobbies & sessions** | Re-keys `.agents/team.state.json` `sessions[oldSession → newSession]`, updates `sessions.jsonl` and `agents/*.yaml` (`reach.session`), re-keys `TeamRecord.lobbies`, and moves `~/.config/team/lobbies/<old>` → `<new>` when owned by this team. |
| **Seat addresses** | `<seat>@<new>` delivers immediately. For `<seat>@<old>`: if another team still holds `project: <old>` (two teams of one name, and the second renames away), `@<old>` resolves unambiguously to that remaining team; otherwise `previousNames` resolves `<seat>@<old>` during grace with a deprecation notice naming `<seat>@<new>`, or refuses when `TEAM_RENAME_GRACE=off` or `until` has expired. |
| **Drops & mailboxes** | `.agents/send-drops/` and `.agents/messages/` remain under `<root>/.agents/`; session-keyed drop folders and signed mailbox payloads move with the session so nothing pending is lost. |
| **Team-scoped grants** | Send-grants in `~/.config/team/grants/` naming `@<old>` are re-signed to `@<new>` when run by the owner (who holds `owner.key`). When run by a lead in dev mode, `sendGrantReissueLine` is printed and `teamSpelled` admits `@<old>` via `previousNames` only while `until` has not expired, `TEAM_RENAME_GRACE` is not `off`, and no current team holds `<old>` by id, project or session. |
