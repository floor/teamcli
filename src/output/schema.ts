import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonSchema } from '../file/sections/section.ts';
import { DELIVERY_LEGS } from '../settings/inherit.ts';
import { DIFFERENCE_WHO_VALUES, SEVERITY_LABELS, SEVERITY_LEVELS } from './text.ts';

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
              nickname: { type: ['string', 'null'] },
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
          nickname: { type: ['string', 'null'] },
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

/** Reusable JSON Schema fragment for a `must_not_pretend` entry (`{ text, ref }`). */
export const MUST_NOT_PRETEND_ENTRY_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'ref'],
  properties: {
    text: { type: 'string', minLength: 1 },
    ref: { type: 'string', minLength: 1 },
  },
};

/** Published `--json` output schema for `team --about` (`schema/about.schema.json`). */
export const ABOUT_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.about',
  fileName: 'about.schema.json',
  title: 'team --about --json output',
  required: ['format', 'version', 'description', 'licence', 'docs', 'must_not_pretend'],
  properties: {
    format: { type: 'integer', const: 1 },
    version: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    licence: { type: 'string', minLength: 1 },
    docs: { type: 'string', minLength: 1 },
    must_not_pretend: {
      type: 'array',
      items: MUST_NOT_PRETEND_ENTRY_SCHEMA_FRAGMENT,
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
    must_not_pretend: {
      type: 'array',
      items: MUST_NOT_PRETEND_ENTRY_SCHEMA_FRAGMENT,
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
    notice: { type: ['string', 'null'] },
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
/** Published `--json` output schema for `team reload` (`schema/reload.schema.json`). */
export const RELOAD_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.reload',
  fileName: 'reload.schema.json',
  title: 'team reload --json output',
  statuses: ['reloaded', 'same'],
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    pane: { type: ['string', 'null'] },
  },
});

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
/** Published `--json` output schema for `team init` (`schema/init.schema.json`). */
export const INIT_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.init',
  fileName: 'init.schema.json',
  title: 'team init --json output',
  statuses: ['wrote', 'restored'],
  required: ['file', 'restored'],
  properties: {
    file: { type: 'string', minLength: 1 },
    restored: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

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
        required: ['ts', 'from', 'to', 'body', 'id', 'outcome', 'status'],
        properties: {
          ts: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          body: { type: 'string' },
          id: { type: 'string' },
          outcome: { type: 'string' },
          // The status the line's outcome derives (§3.3): `sent`, `held`, `delivered`, `read` or
          // `replied`. An attempt outcome the history records — `timeout`, `not-submitted`,
          // `unreachable` — folds to `sent`: it moved no status on the record.
          status: { type: 'string' },
          // The thread the message belongs to (the first message's id), and — on a reply — the
          // record it answers. Present on every line a send of this version writes.
          thread: { type: 'string' },
          in_reply_to: { type: 'string' },
          // Present only on a line the sender measured, as the history log writes it.
          ms: { type: 'number' },
          via: { type: 'string' },
          failed: { type: 'array', items: { type: 'string' } },
          // The qualifier on an outcome the plain word cannot carry alone, as the history log
          // writes it (`taken, not yet confirmed` on a delivered send; `taken but never acted on`).
          note: { type: 'string' },
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

/** Published `--json` output schema for `team policy` (`schema/policy.schema.json`). */
export const POLICY_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.policy',
  fileName: 'policy.schema.json',
  title: 'team policy --json output',
  required: [],
  properties: {},
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'status', 'project', 'session', 'dev_mode_governed', 'policies'],
      properties: {
        schema: schemaTagFragment('team.policy', 1),
        format: { type: 'integer', const: 1 },
        status: { type: 'string', const: 'ok' },
        project: { type: 'string', minLength: 1 },
        session: { type: 'string', minLength: 1 },
        entity: { type: ['string', 'null'] },
        in_project: { type: ['string', 'null'] },
        seat: { type: ['string', 'null'] },
        dev_mode_governed: { type: 'boolean' },
        policies: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value', 'level', 'setter', 'date', 'expiry', 'kind', 'set'],
            properties: {
              name: { type: 'string', minLength: 1 },
              value: {},
              level: { type: 'string', enum: ['default', 'entity', 'project', 'team', 'seat'] },
              setter: { type: ['string', 'null'] },
              date: { type: ['string', 'null'] },
              expiry: { type: ['string', 'null'] },
              kind: { type: 'string', enum: ['enforced', 'advised'] },
              set: { type: 'boolean' },
            },
          },
        },
        notice: { type: ['string', 'null'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'dry_run', 'status', 'action_summary', 'level', 'target', 'policy'],
      properties: {
        schema: schemaTagFragment('team.policy', 1),
        format: { type: 'integer', const: 1 },
        dry_run: { type: 'boolean' },
        status: { type: 'string', enum: ['updated', 'unchanged', 'dry-run'] },
        action_summary: { type: 'string', minLength: 1 },
        project: { type: ['string', 'null'] },
        session: { type: ['string', 'null'] },
        level: { type: 'string', enum: ['entity', 'project', 'team', 'seat'] },
        target: { type: 'string', minLength: 1 },
        policy: { type: 'string', minLength: 1 },
        value: {},
        expiry: { type: ['string', 'null'] },
        kind: { type: 'string', enum: ['enforced', 'advised'] },
        plan: {
          type: 'array',
          items: PLAN_STEP_SCHEMA_FRAGMENT,
        },
        notice: { type: ['string', 'null'] },
      },
    },
  ],
};

/** Published `--json` output schema for `team restart` (`schema/restart.schema.json`). */
export const RESTART_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.restart',
  fileName: 'restart.schema.json',
  title: 'team restart --json output',
  statuses: ['ready', 'dry-run'],
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    pane: { type: ['string', 'null'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team down` (`schema/down.schema.json`). */
export const DOWN_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.down',
  fileName: 'down.schema.json',
  title: 'team down --json output',
  statuses: ['stopped', 'idle', 'dry-run'],
  required: ['seats'],
  properties: {
    seats: { type: 'array', items: { type: 'string', minLength: 1 } },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team up` (`schema/up.schema.json`). */
export const UP_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.up',
  fileName: 'up.schema.json',
  title: 'team up --json output',
  statuses: ['ready', 'dry-run'],
  required: ['seats'],
  properties: {
    seats: { type: 'array', items: { type: 'string', minLength: 1 } },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team add` (`schema/add.schema.json`). */
export const ADD_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.add',
  fileName: 'add.schema.json',
  title: 'team add --json output',
  statuses: ['ready', 'dry-run'],
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    pane: { type: ['string', 'null'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team remove` (`schema/remove.schema.json`). */
export const REMOVE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.remove',
  fileName: 'remove.schema.json',
  title: 'team remove --json output',
  statuses: ['removed', 'kept', 'temporary', 'swapped'],
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team register` (`schema/register.schema.json`). */
export const REGISTER_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.register',
  fileName: 'register.schema.json',
  title: 'team register --json output',
  statuses: ['ready', 'already', 'dry-run'],
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    pane: { type: ['string', 'null'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team ask-show` (`schema/ask-show.schema.json`). */
export const ASK_SHOW_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.ask-show',
  fileName: 'ask-show.schema.json',
  title: 'team ask-show --json output',
  required: ['format', 'request_id', 'question', 'expires_at', 'verified'],
  properties: {
    format: { type: 'integer', const: 1 },
    request_id: { type: 'string', minLength: 1 },
    question: { type: 'string', minLength: 1 },
    expires_at: { type: 'string', minLength: 1 },
    verified: { type: 'boolean', const: true },
  },
};

/** Published `--json` output schema for `team messages` (`schema/messages.schema.json`). */
export const MESSAGES_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.messages',
  fileName: 'messages.schema.json',
  title: 'team messages --json output',
  required: ['format', 'project', 'session', 'rows', 'notes', 'differences', 'summary', 'counts'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'from', 'to', 'sent', 'sent_display', 'status'],
        properties: {
          id: { type: 'string', minLength: 1 },
          from: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] },
          sent: { type: ['string', 'null'] },
          sent_display: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['shown', 'refused'] },
          body: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    differences: { type: 'array', items: DIFFERENCE_SCHEMA_FRAGMENT },
    summary: SUMMARY_SCHEMA_FRAGMENT,
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['messages', 'shown', 'refused'],
      properties: {
        messages: { type: 'integer', minimum: 0 },
        shown: { type: 'integer', minimum: 0 },
        refused: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Published `--json` output schema for `team drops` (`schema/drops.schema.json`). */
export const DROPS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.drops',
  fileName: 'drops.schema.json',
  title: 'team drops --json output',
  required: ['format', 'project', 'session', 'seat', 'drops', 'counts'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    seat: { type: 'string', minLength: 1 },
    drops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'received', 'path'],
        properties: {
          // The sender the record's payload names — or, in a raw file an earlier build wrote, its
          // first line; null when neither names one.
          from: { type: ['string', 'null'] },
          received: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['drops'],
      properties: {
        drops: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Published `--json` output schema for `team reply` (`schema/reply.schema.json`): one record
 *  written on a thread (`replied`), or a close beside the record it ends (`closed`). */
export const REPLY_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.reply',
  fileName: 'reply.schema.json',
  title: 'team reply --json output',
  required: ['format', 'status', 'action_summary', 'project', 'session', 'record', 'thread', 'in_reply_to', 'to', 'rule', 'reply', 'at'],
  properties: {
    format: { type: 'integer', const: 1 },
    status: { type: 'string', enum: ['replied', 'closed'] },
    action_summary: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    // The reply record's id; null on a close, which writes no record.
    record: { type: ['string', 'null'] },
    thread: { type: 'string', minLength: 1 },
    in_reply_to: { type: 'string', minLength: 1 },
    // The seat a reply goes to; null on a close.
    to: { type: ['string', 'null'] },
    // The rule that admitted the reply; null on a close.
    rule: { type: ['string', 'null'] },
    reply: { type: ['string', 'null'] },
    at: { type: 'string', minLength: 1 },
  },
};

/** Published `--json` output schema for `team route` (`schema/route.schema.json`): the action
 *  surface, then the answered address. `session` is the caller's team session; the recipient's
 *  session travels as `recipient_session`. */
export const ROUTE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.route',
  fileName: 'route.schema.json',
  title: 'team route --json output',
  statuses: ['routed', 'dry-run'],
  required: ['project', 'session', 'seat', 'address'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    agent: { type: 'string', minLength: 1 },
    recipient_session: { type: 'string', minLength: 1 },
    cli: { type: 'string', minLength: 1 },
    pane: { type: 'string', minLength: 1 },
    address: { type: ['string', 'null'] },
    socket_state: { type: 'string', enum: ['live', 'stale', 'pane', 'none', 'unread'] },
    native: { type: 'boolean' },
    rule: { type: 'string', minLength: 1 },
  },
});

/** Published `--json` output schema for `team send` (`schema/send.schema.json`): the action
 *  surface every send outcome prints (`team.send`), and the roster `--list` reads
 *  (`team.send.list`). A refused or unreadable run writes the `team.error` envelope instead. */
export const SEND_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.send',
  fileName: 'send.schema.json',
  title: 'team send --json output',
  required: [],
  properties: {},
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'dry_run', 'status', 'action_summary', 'project', 'session', 'seat', 'ids'],
      properties: {
        schema: schemaTagFragment('team.send', 1),
        format: { type: 'integer', const: 1 },
        dry_run: { type: 'boolean' },
        status: { type: 'string', enum: ['delivered', 'delivered (read)', 'sent (unconfirmed)', 'answered', 'recorded', 'native', 'dry-run'] },
        action_summary: { type: 'string', minLength: 1 },
        project: { type: ['string', 'null'] },
        session: { type: ['string', 'null'] },
        seat: { type: 'string', minLength: 1 },
        channel: { type: ['string', 'null'], enum: ['socket', 'typed', 'drop', 'mcp-inbox', 'native', null] },
        to: { type: 'string', minLength: 1 },
        confirm: { type: 'string', minLength: 1 },
        message: { type: 'string' },
        ids: {
          type: 'object',
          additionalProperties: false,
          required: ['sent', 'reply'],
          properties: {
            sent: { type: ['string', 'null'] },
            reply: { type: ['string', 'null'] },
          },
        },
        reply: { type: 'string' },
        address: { type: ['string', 'null'] },
        plan: { type: 'array', items: PLAN_STEP_SCHEMA_FRAGMENT },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'project', 'session', 'seats', 'summary'],
      properties: {
        schema: schemaTagFragment('team.send.list', 1),
        format: { type: 'integer', const: 1 },
        project: { type: 'string', minLength: 1 },
        session: { type: 'string', minLength: 1 },
        seats: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'nickname', 'cli', 'role', 'project', 'reach', 'stopped'],
            properties: {
              name: { type: 'string', minLength: 1 },
              nickname: { type: ['string', 'null'] },
              cli: { type: 'string', minLength: 1 },
              role: { type: 'string' },
              project: { type: 'string', minLength: 1 },
              reach: { type: 'string', enum: ['socket', 'typed'] },
              stopped: { type: 'boolean' },
            },
          },
        },
        summary: { type: 'string', minLength: 1 },
      },
    },
  ],
};

/** Published `--json` output schema for `team answer` (`schema/answer.schema.json`): the action
 *  surface of the one trust dialog answered. A refused or incomplete answer, and a run whose
 *  invocation or team file cannot be read, writes the `team.error` envelope instead. */
export const ANSWER_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.answer',
  fileName: 'answer.schema.json',
  title: 'team answer --json output',
  statuses: ['answered'],
  required: ['project', 'session', 'seat', 'pane', 'dialog', 'state'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    pane: { type: ['string', 'null'] },
    dialog: { type: 'string', const: 'trust' },
    state: { type: 'string', const: 'ready' },
    folder: { type: 'string', minLength: 1 },
  },
});

/** Published `--json` output schema for `team mcp` (`schema/mcp.schema.json`): the status
 *  report (the helper rows, each bridge, each guard, the front and the state they add up to)
 *  and the doctor report (the findings and their counts). A run whose invocation cannot be
 *  read writes the `team.error` envelope instead. */
export const MCP_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.mcp',
  fileName: 'mcp.schema.json',
  title: 'team mcp --json output',
  required: [],
  properties: {},
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'lobby_dir', 'helper', 'bridges', 'guards', 'front', 'state'],
      properties: {
        schema: schemaTagFragment('team.mcp', 1),
        format: { type: 'integer', const: 1 },
        lobby_dir: { type: 'string', minLength: 1 },
        helper: {
          type: 'object',
          additionalProperties: false,
          required: ['root', 'present', 'rows'],
          properties: {
            root: { type: 'string', minLength: 1 },
            present: { type: 'boolean' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'state', 'detail'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  state: { type: 'string', enum: [...Object.values(SEVERITY_LABELS)] },
                  detail: { type: 'string' },
                },
              },
            },
          },
        },
        bridges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dir', 'config', 'problem', 'wss_url', 'seats', 'signer_socket', 'bridge_process', 'mailbox', 'inbox_outbox', 'audit'],
            properties: {
              dir: { type: 'string', minLength: 1 },
              config: { type: 'string', enum: ['ok', 'invalid'] },
              problem: { type: ['string', 'null'] },
              wss_url: { type: ['string', 'null'] },
              seats: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['alias', 'route', 'key_id'],
                  properties: {
                    alias: { type: 'string', minLength: 1 },
                    route: { type: 'string', minLength: 1 },
                    key_id: { type: 'string', minLength: 1 },
                  },
                },
              },
              signer_socket: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['path', 'state'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  state: { type: 'string', enum: ['ok', 'refused', 'missing', 'unknown'] },
                },
              },
              bridge_process: { type: 'string', enum: ['up', 'down', 'unknown'] },
              mailbox: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['outbound_ready', 'inbound_ready'],
                properties: {
                  outbound_ready: { type: ['integer', 'null'], minimum: 0 },
                  inbound_ready: { type: ['integer', 'null'], minimum: 0 },
                },
              },
              inbox_outbox: { type: ['string', 'null'] },
              audit: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['path', 'last'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  last: {
                    type: ['object', 'null'],
                    additionalProperties: false,
                    required: ['ts', 'event'],
                    properties: {
                      ts: { type: 'string', minLength: 1 },
                      event: { type: 'string', minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
        guards: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dir', 'config', 'problem', 'enabled', 'last_audit'],
            properties: {
              dir: { type: 'string', minLength: 1 },
              config: { type: 'string', enum: ['ok', 'invalid'] },
              problem: { type: ['string', 'null'] },
              enabled: { type: ['boolean', 'null'] },
              last_audit: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['ts', 'event'],
                properties: {
                  ts: { type: 'string', minLength: 1 },
                  event: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        front: {
          type: 'object',
          additionalProperties: false,
          required: ['origin', 'mcp_status', 'connector_status', 'tls_valid_to', 'tls_authorized'],
          properties: {
            origin: { type: ['string', 'null'] },
            mcp_status: { type: ['integer', 'null'] },
            connector_status: { type: ['integer', 'null'] },
            tls_valid_to: { type: ['string', 'null'] },
            tls_authorized: { type: ['boolean', 'null'] },
          },
        },
        state: { type: 'string', enum: ['up', 'down', 'not-set-up'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'lobby_dir', 'findings', 'missing', 'warnings'],
      properties: {
        schema: schemaTagFragment('team.mcp', 1),
        format: { type: 'integer', const: 1 },
        lobby_dir: { type: 'string', minLength: 1 },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['level', 'text', 'fix'],
            properties: {
              level: { type: 'string', enum: [...SEVERITY_LEVELS] },
              text: { type: 'string', minLength: 1 },
              fix: { type: ['string', 'null'] },
            },
          },
        },
        missing: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
      },
    },
  ],
};


/** Published `--json` output schema for `team tempo` (`schema/tempo.schema.json`). */
export const TEMPO_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.tempo',
  fileName: 'tempo.schema.json',
  title: 'team tempo --json output',
  statuses: ['set', 'same'],
  required: ['project', 'session', 'value'],
  properties: {
    value: { type: ['string', 'null'] },
  },
});

/** The `team.proc` action envelope, on `add` and `done`. */
const PROC_ACTION_BRANCH: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'format', 'dry_run', 'status', 'action_summary', 'project', 'session', 'target'],
  properties: {
    schema: schemaTagFragment('team.proc', 1),
    format: { type: 'integer', const: 1 },
    dry_run: { type: 'boolean' },
    status: { type: 'string', enum: ['added', 'done'] },
    action_summary: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    value: { type: ['string', 'null'] },
    notice: { type: ['string', 'null'] },
  },
};

/** The `team.proc` reading document, on `list`. */
const PROC_LIST_BRANCH: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'format', 'project', 'session', 'notice', 'procs', 'summary'],
  properties: {
    schema: schemaTagFragment('team.proc', 1),
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    notice: { type: ['string', 'null'] },
    procs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'by', 'since', 'pid', 'note'],
        properties: {
          name: { type: 'string', minLength: 1 },
          by: { type: 'string', minLength: 1 },
          since: { type: 'string', minLength: 1 },
          pid: { type: ['integer', 'null'], minimum: 1 },
          note: { type: ['string', 'null'] },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['processes'],
      properties: {
        processes: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Published `--json` output schema for `team proc` (`schema/proc.schema.json`). */
export const PROC_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.proc',
  fileName: 'proc.schema.json',
  title: 'team proc --json output',
  properties: {},
  oneOf: [PROC_ACTION_BRANCH, PROC_LIST_BRANCH],
};

/** The `team.worktree` action envelope, on `new` and `remove`. */
const WORKTREE_ACTION_BRANCH: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'format', 'dry_run', 'status', 'action_summary', 'project', 'session', 'action', 'task'],
  properties: {
    schema: schemaTagFragment('team.worktree', 1),
    format: { type: 'integer', const: 1 },
    dry_run: { type: 'boolean' },
    status: { type: 'string', enum: ['created', 'removed', 'record-gone'] },
    action_summary: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['new', 'remove'] },
    task: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    notice: { type: ['string', 'null'] },
  },
};

/** The `team.worktree` reading document, on `list`. */
const WORKTREE_LIST_BRANCH: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'format', 'project', 'session', 'notice', 'worktrees', 'notes', 'summary'],
  properties: {
    schema: schemaTagFragment('team.worktree', 1),
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    notice: { type: ['string', 'null'] },
    worktrees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'branch', 'path', 'session', 'seat', 'exists'],
        properties: {
          task: { type: 'string', minLength: 1 },
          branch: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
          session: { type: 'string', minLength: 1 },
          seat: { type: ['string', 'null'] },
          exists: { type: 'boolean' },
        },
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['worktrees'],
      properties: {
        worktrees: { type: 'integer', minimum: 0 },
      },
    },
  },
};

/** Published `--json` output schema for `team worktree` (`schema/worktree.schema.json`). */
export const WORKTREE_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.worktree',
  fileName: 'worktree.schema.json',
  title: 'team worktree --json output',
  properties: {},
  oneOf: [WORKTREE_ACTION_BRANCH, WORKTREE_LIST_BRANCH],
};

/** Reusable JSON Schema fragment for a check finding (`{ kind, message, line?, text? }`). */
export const FINDING_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'message'],
  properties: {
    kind: {
      type: 'string',
      enum: ['forbidden', 'signature-missing', 'signature-misplaced', 'signature-in-prose', 'signature-unknown'],
    },
    message: { type: 'string', minLength: 1 },
    line: { type: 'integer', minimum: 1 },
    text: { type: 'string' },
  },
};

/** The commit a `team.commits` document reports on. */
const COMMIT_REPORT_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hash', 'subject', 'status', 'exempt', 'findings'],
  properties: {
    hash: { type: 'string', minLength: 1 },
    subject: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'refused', 'exempt'] },
    exempt: { type: ['string', 'null'], enum: ['merge', 'human', null] },
    findings: {
      type: 'array',
      items: FINDING_SCHEMA_FRAGMENT,
    },
  },
};

/** Published `--json` output schema for `team commits check` (`schema/commits.schema.json`). */
export const COMMITS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.commits',
  fileName: 'commits.schema.json',
  title: 'team commits check --json output',
  required: ['format', 'ref', 'since', 'commits', 'skipped', 'pull_request', 'differences', 'notes', 'summary', 'notice'],
  properties: {
    format: { type: 'integer', const: 1 },
    ref: { type: 'string', minLength: 1 },
    since: { type: ['string', 'null'] },
    commits: {
      type: 'array',
      items: COMMIT_REPORT_SCHEMA_FRAGMENT,
    },
    skipped: { type: 'integer', minimum: 0 },
    pull_request: {
      type: ['array', 'null'],
      items: FINDING_SCHEMA_FRAGMENT,
    },
    differences: {
      type: 'array',
      items: DIFFERENCE_SCHEMA_FRAGMENT,
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['commits', 'refused', 'exempt', 'skipped', 'ok'],
      properties: {
        commits: { type: 'integer', minimum: 0 },
        refused: { type: 'integer', minimum: 0 },
        exempt: { type: 'integer', minimum: 0 },
        skipped: { type: 'integer', minimum: 0 },
        ok: { type: 'boolean' },
      },
    },
    notice: { type: ['string', 'null'] },
  },
};

/** Published `--json` output schema for `team pr check` (`schema/pr.schema.json`). */
export const PR_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.pr',
  fileName: 'pr.schema.json',
  title: 'team pr check --json output',
  required: ['format', 'differences', 'notes', 'summary', 'notice'],
  properties: {
    format: { type: 'integer', const: 1 },
    differences: {
      type: 'array',
      items: DIFFERENCE_SCHEMA_FRAGMENT,
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
    summary: SUMMARY_SCHEMA_FRAGMENT,
    notice: { type: ['string', 'null'] },
  },
};

/** Published `--json` output schema for `team usage` (`schema/usage.schema.json`): the machine's
 *  report, envelope-first. Its machine rows and quota block are the report's own DTO, whose inner
 *  objects are rendered by the same two faces that read them, so the schema pins the document's
 *  frame and the counts it closes on, the way `team status`'s schema pins its frame. */
export const USAGE_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.usage',
  fileName: 'usage.schema.json',
  title: 'team usage --json output',
  required: ['format', 'at', 'view', 'mine', 'counts', 'labs', 'quota', 'unknown', 'notes', 'teams'],
  properties: {
    format: { type: 'integer', const: 1 },
    at: { type: 'string', minLength: 1 },
    view: { type: 'string', enum: ['full', 'restricted'] },
    mine: { type: ['string', 'null'] },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['teams', 'labs', 'accounts'],
      properties: {
        teams: { type: 'integer', minimum: 0 },
        labs: { type: 'integer', minimum: 0 },
        accounts: { type: 'integer', minimum: 0 },
      },
    },
    labs: { type: 'array', items: { type: 'object' } },
    quota: { type: 'object' },
    unknown: { type: 'array', items: { type: 'object' } },
    notes: { type: 'array', items: { type: 'object' } },
    teams: { type: 'array', items: { type: 'object' } },
  },
};

/** Registry of published command output schemas under `schema/`. */
export const COMMAND_OUTPUT_SCHEMAS: readonly CommandSchemaSpec[] = [
  ERROR_OUTPUT_SCHEMA,
  ABOUT_OUTPUT_SCHEMA,
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
  POLICY_OUTPUT_SCHEMA,
  ISSUES_OUTPUT_SCHEMA,
  FEED_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  NEXT_OUTPUT_SCHEMA,
  RELOAD_OUTPUT_SCHEMA,
  INIT_OUTPUT_SCHEMA,
  RESTART_OUTPUT_SCHEMA,
  DOWN_OUTPUT_SCHEMA,
  UP_OUTPUT_SCHEMA,
  ADD_OUTPUT_SCHEMA,
  REMOVE_OUTPUT_SCHEMA,
  REGISTER_OUTPUT_SCHEMA,
  ASK_SHOW_OUTPUT_SCHEMA,
  MESSAGES_OUTPUT_SCHEMA,
  DROPS_OUTPUT_SCHEMA,
  ROUTE_OUTPUT_SCHEMA,
  SEND_OUTPUT_SCHEMA,
  REPLY_OUTPUT_SCHEMA,
  ANSWER_OUTPUT_SCHEMA,
  MCP_OUTPUT_SCHEMA,
  TEMPO_OUTPUT_SCHEMA,
  PROC_OUTPUT_SCHEMA,
  WORKTREE_OUTPUT_SCHEMA,
  COMMITS_OUTPUT_SCHEMA,
  PR_OUTPUT_SCHEMA,
  USAGE_OUTPUT_SCHEMA,
];


