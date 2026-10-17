import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonSchema } from '../file/sections/section.ts';
import { DELIVERY_LEGS } from '../settings/inherit.ts';
import { DIFFERENCE_WHO_VALUES, SEVERITY_LEVELS } from './text.ts';

export interface CommandSchemaSpec {
  /** Schema identifier, e.g. `'team.status'` or `'team.error'`. */
  name: string;
  /** File name under `schema/`, e.g. `'status.schema.json'`. */
  fileName: string;
  /** Human-readable title for the JSON Schema. */
  title: string;
  /** Schema integer version; defaults to `1`. */
  version?: number;
  /** Required top-level properties in addition to `'schema'`. */
  required?: readonly string[];
  /** Top-level property schemas in addition to `'schema'`. */
  properties: Record<string, JsonSchema>;
  /** Optional `oneOf` / `anyOf` branches when a command has multiple `--json` shapes (e.g. team vs `--project`). */
  oneOf?: readonly JsonSchema[];
}

export interface ActionSchemaSpec {
  /** Schema identifier, e.g. `'team.add'` or `'team.up'`. */
  name: string;
  /** File name under `schema/`, e.g. `'add.schema.json'`. */
  fileName: string;
  /** Human-readable title for the JSON Schema. */
  title: string;
  /** Schema integer version; defaults to `1`. */
  version?: number;
  /** Allowed `status` values for this action command (e.g. `['ready', 'dry-run']`). */
  statuses?: readonly string[];
  /** Additional required top-level properties beyond `format`, `dry_run`, `status`, `action_summary`. */
  required?: readonly string[];
  /** Command-specific properties merged alongside the base action envelope properties. */
  properties?: Record<string, JsonSchema>;
}

/** Reusable JSON Schema fragment for the top-level `schema: { name, version }` tag. */
export function schemaTagFragment(name?: string, version = 1): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'version'],
    properties: {
      name: name ? { type: 'string', const: name } : { type: 'string', minLength: 1 },
      version: { type: 'integer', const: version },
    },
  };
}

/** Reusable JSON Schema fragment for a difference item (`{ what, repair, who }`). */
export const DIFFERENCE_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['what', 'repair', 'who'],
  properties: {
    what: { type: 'string', minLength: 1 },
    repair: { type: 'string', minLength: 1 },
    who: {
      type: 'string',
      enum: [...DIFFERENCE_WHO_VALUES],
    },
  },
};

/** Reusable JSON Schema fragment for a difference summary (`{ differences, owner_differences }`). */
export const SUMMARY_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['differences', 'owner_differences'],
  properties: {
    differences: { type: 'integer', minimum: 0 },
    owner_differences: { type: 'integer', minimum: 0 },
  },
};

/** Reusable JSON Schema fragment for a `--dry-run` plan step (`{ step, detail, seat?, prefix? }`). */
export const PLAN_STEP_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['step', 'detail'],
  properties: {
    step: { type: 'string', minLength: 1 },
    detail: { type: 'string', minLength: 1 },
    seat: { type: ['string', 'null'] },
    prefix: { type: 'string', enum: ['+', '!', 'skip'] },
  },
};

/** Builds a `CommandSchemaSpec` for an action command (`ActionResultBase` + command-specific fields). */
export function buildActionSchemaSpec(spec: ActionSchemaSpec): CommandSchemaSpec {
  const baseRequired = ['format', 'dry_run', 'status', 'action_summary'];
  const extraRequired = (spec.required ?? []).filter((key) => !baseRequired.includes(key));
  return {
    name: spec.name,
    fileName: spec.fileName,
    title: spec.title,
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    required: [...baseRequired, ...extraRequired],
    properties: {
      format: { type: 'integer', const: 1 },
      dry_run: { type: 'boolean' },
      status: spec.statuses && spec.statuses.length > 0
        ? { type: 'string', enum: [...spec.statuses] }
        : { type: 'string', minLength: 1 },
      action_summary: { type: 'string', minLength: 1 },
      project: { type: ['string', 'null'] },
      session: { type: ['string', 'null'] },
      plan: {
        type: 'array',
        items: PLAN_STEP_SCHEMA_FRAGMENT,
      },
      notice: { type: ['string', 'null'] },
      ...(spec.properties ?? {}),
    },
  };
}

/** Build a Draft 2020-12 JSON Schema object for a command's `--json` output. */
export function buildCommandOutputSchema(spec: CommandSchemaSpec): JsonSchema {
  const version = spec.version ?? 1;
  const base: JsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/floor/teamcli/blob/main/schema/${spec.fileName}`,
    title: spec.title,
    $comment: 'generated from src/output/schema.ts: the output contract in docs/reference/output.md is the source of truth',
    type: 'object',
  };
  if (spec.oneOf) {
    return {
      ...base,
      oneOf: [...spec.oneOf],
    };
  }
  const required = ['schema', ...(spec.required ?? []).filter((key) => key !== 'schema')];
  return {
    ...base,
    additionalProperties: false,
    required,
    properties: {
      schema: schemaTagFragment(spec.name, version),
      ...spec.properties,
    },
  };
}

/** Renders a `CommandSchemaSpec` as formatted JSON with trailing newline. */
export function renderCommandOutputSchema(spec: CommandSchemaSpec): string {
  return `${JSON.stringify(buildCommandOutputSchema(spec), null, 2)}\n`;
}

/** Writes or checks a command output schema file under `<root>/schema/<spec.fileName>`. */
export function publishCommandOutputSchema(
  rootDir: string,
  spec: CommandSchemaSpec,
  mode: 'write' | 'check' = 'check',
): { ok: boolean; path: string; message?: string } {
  const target = join(rootDir, 'schema', spec.fileName);
  const rendered = renderCommandOutputSchema(spec);
  if (mode === 'write') {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    return { ok: true, path: target };
  }
  if (!existsSync(target)) {
    return { ok: false, path: target, message: `schema/${spec.fileName} is missing` };
  }
  const current = readFileSync(target, 'utf8');
  if (current !== rendered) {
    return { ok: false, path: target, message: `schema/${spec.fileName} is out of date` };
  }
  return { ok: true, path: target };
}

/** Standard schema for `team.error` (`schema/error.schema.json`). */
export const ERROR_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.error',
  fileName: 'error.schema.json',
  title: 'A team command error envelope (--json)',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'message', 'repair'],
      properties: {
        id: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        repair: { type: ['string', 'null'] },
        rule: { type: ['string', 'null'] },
      },
    },
    notice: { type: ['string', 'null'] },
  },
};

/** Published `--json` output schema for the pilot `team status` command (`schema/status.schema.json`). */
export const STATUS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.status',
  fileName: 'status.schema.json',
  title: 'team status --json output',
  required: [],
  properties: {},
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'project', 'session', 'rows', 'notes', 'differences', 'summary', 'notice'],
      properties: {
        schema: schemaTagFragment('team.status', 1),
        format: { type: 'integer', const: 1 },
        project: { type: 'string', minLength: 1 },
        session: { type: 'string', minLength: 1 },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'state', 'model', 'pane'],
            properties: {
              name: { type: 'string', minLength: 1 },
              id: { type: ['string', 'null'] },
              role: { type: 'string' },
              cli: { type: 'string' },
              state: { type: 'string', minLength: 1 },
              model: { type: 'string', minLength: 1 },
              effort: { type: ['string', 'null'] },
              last_active: { type: ['string', 'null'] },
              pane: { type: 'string', minLength: 1 },
              reach: { type: 'string', enum: ['socket', 'typed'] },
              launch_line: { type: ['string', 'null'] },
              seat_state: { type: 'string' },
              seat_state_source: { type: 'string' },
              blind: { type: 'boolean', const: true },
              dev_mode: { type: 'boolean' },
              start_cwd: { type: 'string' },
            },
          },
        },
        notes: {
          type: 'array',
          items: { type: 'string' },
        },
        differences: {
          type: 'array',
          items: DIFFERENCE_SCHEMA_FRAGMENT,
        },
        summary: SUMMARY_SCHEMA_FRAGMENT,
        notice: { type: ['string', 'null'] },
        budgets: {
          type: 'array',
          items: { type: 'object' },
        },
        hold: {
          type: 'object',
        },
        procs: {
          type: 'array',
          items: { type: 'object' },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'project', 'teams'],
      properties: {
        schema: schemaTagFragment('team.status.project', 1),
        format: { type: 'integer', const: 1 },
        project: { type: 'object' },
        teams: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'session', 'lifecycle', 'seats'],
            properties: {
              name: { type: 'string' },
              session: { type: ['string', 'null'] },
              lifecycle: { type: ['string', 'null'] },
              seats: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
  ],
};

/** Published `--json` output schema for `team seats` (`schema/seats.schema.json`). */
export const SEATS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.seats',
  fileName: 'seats.schema.json',
  title: 'team seats --json output',
  required: ['format', 'project', 'session', 'seats'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    notice: { type: ['string', 'null'] },
    seats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'id',
          'role',
          'cli',
          'model',
          'effort',
          'status',
          'state',
          'state_source',
          'last_active',
          'pane',
          'launch_line',
        ],
        properties: {
          name: { type: 'string', minLength: 1 },
          id: { type: ['string', 'null'] },
          role: { type: 'string', minLength: 1 },
          cli: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          effort: { type: ['string', 'null'] },
          status: { type: 'string', minLength: 1 },
          state: { type: 'string', minLength: 1 },
          state_source: { type: 'string', minLength: 1 },
          blind: { type: 'boolean', const: true },
          last_active: { type: ['string', 'null'] },
          pane: { type: ['string', 'null'] },
          launch_line: { type: ['string', 'null'] },
          dev_mode: { type: 'boolean' },
          start_cwd: { type: 'string' },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team projects` (`schema/projects.schema.json`). */
export const PROJECTS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.projects',
  fileName: 'projects.schema.json',
  title: 'team projects --json output',
  required: ['format', 'projects'],
  properties: {
    format: { type: 'integer', const: 1 },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'entity', 'lead', 'teams', 'provenance'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          entity: { type: ['string', 'null'] },
          lead: { type: ['string', 'null'] },
          teams: {
            type: 'array',
            items: { type: 'string' },
          },
          deliveryOrder: {
            type: 'array',
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          provenance: {
            type: 'object',
            additionalProperties: false,
            required: ['registered_by', 'registered_at', 'updated_at'],
            properties: {
              registered_by: { type: 'string' },
              registered_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team doctor` (`schema/doctor.schema.json`). */
export const DOCTOR_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.doctor',
  fileName: 'doctor.schema.json',
  title: 'team doctor --json output',
  required: ['format', 'project', 'session', 'findings', 'summary'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    login_only: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'text', 'blocks_launch'],
        properties: {
          level: { type: 'string', enum: [...SEVERITY_LEVELS] },
          text: { type: 'string', minLength: 1 },
          blocks_launch: { type: 'boolean' },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['missing', 'warnings', 'blockers'],
      properties: {
        missing: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
        blockers: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Published `--json` output schema for `team check` (`schema/check.schema.json`). */
export const CHECK_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.check',
  fileName: 'check.schema.json',
  title: 'team check --json output',
  required: ['format', 'project', 'session', 'warnings', 'repaired', 'notes', 'differences', 'summary'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
    repaired: {
      type: 'array',
      items: { type: 'string' },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
    differences: {
      type: 'array',
      items: DIFFERENCE_SCHEMA_FRAGMENT,
    },
    summary: SUMMARY_SCHEMA_FRAGMENT,
  },
};

/** Published `--json` output schema for `team list` (`schema/list.schema.json`). */
export const LIST_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.list',
  fileName: 'list.schema.json',
  title: 'team list --json output',
  required: ['format', 'rows'],
  properties: {
    format: { type: 'integer', const: 1 },
    rows: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['team', 'project', 'status', 'seats', 'activity', 'note'],
            properties: {
              team: { type: 'string', minLength: 1 },
              project: { type: 'string', minLength: 1 },
              status: { type: 'string', enum: ['running', 'stopped'] },
              seats: { type: 'string', minLength: 1 },
              activity: { type: 'string', minLength: 1 },
              active: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['ready', 'working', 'waiting', 'stopped'],
                properties: {
                  ready: { type: 'integer', minimum: 0 },
                  working: { type: 'integer', minimum: 0 },
                  waiting: { type: 'integer', minimum: 0 },
                  stopped: { type: 'integer', minimum: 0 },
                },
              },
              roster: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'status'],
                  properties: {
                    name: { type: ['string', 'null'] },
                    status: { type: ['string', 'null'] },
                    id: { type: ['string', 'null'] },
                    role: { type: ['string', 'null'] },
                    cli: { type: ['string', 'null'] },
                    model: { type: ['string', 'null'] },
                    effort: { type: ['string', 'null'] },
                    pane: { type: ['string', 'null'] },
                    last_active: { type: ['string', 'null'] },
                  },
                },
              },
              note: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'team', 'project', 'lobby', 'seats', 'defined', 'approved', 'running', 'source'],
            properties: {
              entity: { type: ['string', 'null'] },
              team: { type: 'string', minLength: 1 },
              project: { type: ['string', 'null'] },
              lobby: { type: ['string', 'null'] },
              seats: { type: ['integer', 'null'], minimum: 0 },
              defined: { type: 'boolean' },
              approved: { type: 'boolean' },
              running: { type: ['boolean', 'null'] },
              source: { type: 'string', enum: ['registry', 'discovered'] },
              roster: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['seat'],
                  properties: {
                    seat: { type: 'string', minLength: 1 },
                    agent: { type: ['string', 'null'] },
                    role: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
};

/** Published `--json` output schema for `team grant` (`schema/grant.schema.json`). */
export const GRANT_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.grant',
  fileName: 'grant.schema.json',
  title: 'team grant --json output',
  statuses: ['updated', 'unchanged', 'dry-run'],
  required: ['project', 'session', 'target'],
  properties: {
    target: { type: 'string', minLength: 1 },
    capabilities: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    scope: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
});

/** Published `--json` output schema for `team delegate` (`schema/delegate.schema.json`). */
export const DELEGATE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.delegate',
  fileName: 'delegate.schema.json',
  title: 'team delegate --json output',
  statuses: ['updated', 'unchanged', 'dry-run'],
  required: ['project', 'session', 'target', 'commands'],
  properties: {
    target: { type: 'string', minLength: 1 },
    commands: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
});

/** Published `--json` output schema for `team revoke` (`schema/revoke.schema.json`). */
export const REVOKE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.revoke',
  fileName: 'revoke.schema.json',
  title: 'team revoke --json output',
  statuses: ['updated', 'unchanged', 'dry-run'],
  required: ['project', 'session', 'target'],
  properties: {
    target: { type: 'string', minLength: 1 },
  },
});

/** Published `--json` output schema for `team hold` (`schema/hold.schema.json`). */
export const HOLD_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.hold',
  fileName: 'hold.schema.json',
  title: 'team hold --json output',
  statuses: ['placed', 'released'],
  required: ['project', 'session', 'target', 'value'],
  properties: {
    target: { type: 'string', minLength: 1 },
    value: { type: ['string', 'null'] },
    hold: {
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'by', 'at'],
      properties: {
        reason: { type: 'string', minLength: 1 },
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
        until: { type: 'string', minLength: 1 },
      },
    },
  },
});

/** Published `--json` output schema for `team lock` (`schema/lock.schema.json`). */
export const LOCK_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.lock',
  fileName: 'lock.schema.json',
  title: 'team lock --json output',
  statuses: ['taken'],
  required: ['project', 'target', 'value', 'holder'],
  properties: {
    target: { type: 'string', minLength: 1 },
    value: { type: ['string', 'null'] },
    holder: {
      type: 'object',
      additionalProperties: false,
      required: ['team', 'run', 'by', 'at'],
      properties: {
        team: { type: 'string', minLength: 1 },
        run: { type: 'string' },
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
      },
    },
  },
});

/** Published `--json` output schema for `team unlock` (`schema/unlock.schema.json`). */
export const UNLOCK_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.unlock',
  fileName: 'unlock.schema.json',
  title: 'team unlock --json output',
  statuses: ['released'],
  required: ['project', 'target', 'value'],
  properties: {
    target: { type: 'string', minLength: 1 },
    value: { type: ['string', 'null'] },
  },
});
/** Published `--json` output schema for `team issues` (`schema/issues.schema.json`). */
export const ISSUES_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.issues',
  fileName: 'issues.schema.json',
  title: 'team issues --json output',
  required: ['format', 'project', 'session', 'issues'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'state', 'assignee'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          state: { type: 'string', enum: ['open', 'blocked'] },
          assignee: { type: ['string', 'null'] },
          priority: { type: ['string', 'number'] },
          milestone: { type: 'string' },
          deadline: { type: 'string' },
          blocked_by: { type: 'array', items: { type: 'string' } },
          repos: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team plan` (`schema/plan.schema.json`). */
export const PLAN_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.plan',
  fileName: 'plan.schema.json',
  title: 'team plan --json output',
  required: ['format', 'project', 'session', 'tasks'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'state', 'owner', 'id', 'title'],
        properties: {
          step: { type: 'integer', minimum: 1 },
          state: { type: 'string', enum: ['open', 'overdue'] },
          owner: { type: ['string', 'null'] },
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          priority: { type: ['string', 'number'] },
          milestone: { type: 'string' },
          deadline: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team feed` (`schema/feed.schema.json`). */
export const FEED_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.feed',
  fileName: 'feed.schema.json',
  title: 'team feed --json output',
  required: ['format', 'project', 'session', 'events'],
  properties: {
    format: { type: 'integer', const: 1 },
    // A run outside a checkout, or one scanning every team with `--all`, names no single team.
    project: { type: ['string', 'null'] },
    session: { type: ['string', 'null'] },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ts', 'from', 'to', 'body', 'id', 'outcome'],
        properties: {
          ts: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          body: { type: 'string' },
          id: { type: 'string' },
          outcome: { type: 'string' },
          // Present only on a line the sender measured, as the history log writes it.
          ms: { type: 'number' },
          via: { type: 'string' },
          failed: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team next` (`schema/next.schema.json`). */
export const NEXT_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.next',
  fileName: 'next.schema.json',
  title: 'team next --json output',
  statuses: ['claimed', 'released', 'none'],
  required: ['project', 'session', 'action', 'task'],
  properties: {
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['claim', 'release', 'none'] },
    // The claimed record's id and title, null for a release or an empty answer.
    task: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title'],
          properties: {
            id: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
          },
        },
      ],
    },
  },
});

const RELEASE_CHECK_OUTCOME_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'detail'],
  properties: {
    status: { type: 'string', enum: ['pass', 'missing', 'unknown'] },
    detail: { type: 'string', minLength: 1 },
  },
};

/** Published `--json` output schema for `team release` (`schema/release.schema.json`). */
export const RELEASE_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.release',
  fileName: 'release.schema.json',
  title: 'team release --json output',
  required: ['format', 'package', 'version', 'checks', 'summary'],
  properties: {
    format: { type: 'integer', const: 1 },
    package: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: ['npm', 'tag', 'github', 'changelog'],
      properties: {
        npm: RELEASE_CHECK_OUTCOME_FRAGMENT,
        tag: RELEASE_CHECK_OUTCOME_FRAGMENT,
        github: RELEASE_CHECK_OUTCOME_FRAGMENT,
        changelog: RELEASE_CHECK_OUTCOME_FRAGMENT,
        linear: RELEASE_CHECK_OUTCOME_FRAGMENT,
        activity: RELEASE_CHECK_OUTCOME_FRAGMENT,
      },
    },
    warning: { type: 'string', minLength: 1 },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['checks', 'missing', 'unknown'],
      properties: {
        checks: { type: 'integer', minimum: 0 },
        missing: { type: 'integer', minimum: 0 },
        unknown: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Registry of published command output schemas under `schema/`. */
export const COMMAND_OUTPUT_SCHEMAS: readonly CommandSchemaSpec[] = [
  ERROR_OUTPUT_SCHEMA,
  STATUS_OUTPUT_SCHEMA,
  SEATS_OUTPUT_SCHEMA,
  PROJECTS_OUTPUT_SCHEMA,
  DOCTOR_OUTPUT_SCHEMA,
  CHECK_OUTPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  GRANT_OUTPUT_SCHEMA,
  DELEGATE_OUTPUT_SCHEMA,
  REVOKE_OUTPUT_SCHEMA,
  HOLD_OUTPUT_SCHEMA,
  LOCK_OUTPUT_SCHEMA,
  UNLOCK_OUTPUT_SCHEMA,
  RELEASE_OUTPUT_SCHEMA,
  ISSUES_OUTPUT_SCHEMA,
  FEED_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  NEXT_OUTPUT_SCHEMA,
];


