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
        status: { type: 'string', enum: ['delivered', 'answered', 'recorded', 'dry-run'] },
        action_summary: { type: 'string', minLength: 1 },
        project: { type: ['string', 'null'] },
        session: { type: ['string', 'null'] },
        seat: { type: 'string', minLength: 1 },
        channel: { type: ['string', 'null'], enum: ['socket', 'typed', 'native', null] },
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
            required: ['name', 'cli', 'role', 'project', 'reach', 'stopped'],
            properties: {
              name: { type: 'string', minLength: 1 },
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

/** Registry of published command output schemas under `schema/`. */
export const COMMAND_OUTPUT_SCHEMAS: readonly CommandSchemaSpec[] = [
  ERROR_OUTPUT_SCHEMA,
  STATUS_OUTPUT_SCHEMA,
  SEATS_OUTPUT_SCHEMA,
  PROJECTS_OUTPUT_SCHEMA,
  DOCTOR_OUTPUT_SCHEMA,
  CHECK_OUTPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  USAGE_OUTPUT_SCHEMA,
  ASK_SHOW_OUTPUT_SCHEMA,
  MESSAGES_OUTPUT_SCHEMA,
  ROUTE_OUTPUT_SCHEMA,
  SEND_OUTPUT_SCHEMA,
  ANSWER_OUTPUT_SCHEMA,
];

