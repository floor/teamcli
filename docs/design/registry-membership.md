# Registry membership across a launch

A launch keeps a project membership already stored on the team record when the team file does not name `in_project`. It does not clear `project_id` in that case.

Fixtures that set membership write it on the team record, through `upsertTeam` with `projectId`.
