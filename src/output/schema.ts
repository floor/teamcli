import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonSchema } from '../file/sections/section.ts';
import { CONFIG_KEYS, CONFIG_LEVELS } from '../config/registry.ts';
import { PRESENCE_EVENTS, PRESENCE_STATES, PRESENCE_WRITER_SOURCES } from '../daemon/presence/contract.ts';
import { DELIVERY_LEGS, SENDER_NAME_MODES } from '../settings/inherit.ts';
import { DIFFERENCE_WHO_VALUES, SEVERITY_LABELS, SEVERITY_LEVELS } from './text.ts';

/** The `source` words a settings row prints: a signed record's level, the team file's entry,
 *  its team order, the release default, or no value at all. */
const CONFIG_SOURCE_WORDS = [
  'entity record',
  'project record',
  'team record',
  'seat record',
  'team file',
  'team default',
  'default',
  'none',
];

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

/** One ordered entry of a send's delivery report: the leg, its state, and — on a dry run —
 *  whether the walk would take it, with the word that keeps it out when it would not. Shared by
 *  the action document and the error document, so a failed send reports the same legs a
 *  delivered one does. */
const DELIVERY_LEGS_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['leg', 'state'],
    properties: {
      leg: { type: 'string', enum: [...DELIVERY_LEGS] },
      state: { type: 'string', enum: ['attempted', 'queued', 'skipped', 'refused', 'not-reached', 'candidate'] },
      eligible: { type: 'boolean' },
      reason: { type: 'string', minLength: 1 },
    },
  },
};

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
    /** The declared limitation of a client app key, carried on a client invocation's usage error. */
    key_isolation: { type: 'string', minLength: 1 },
    /** A send's resolved walk, on a run that reached one: the failed send reports the same
     *  ordered legs a delivered one does. Other commands' errors never carry it. */
    delivery: DELIVERY_LEGS_SCHEMA_FRAGMENT,
  },
};

/** The idle-with-work reading as the producer writes it (`src/idle_work.ts`), shared by the two
 *  commands that print it: a field added there without its schema fails the smoke check. */
const IDLE_WORK_SCHEMA_FRAGMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'at', 'threshold_seconds', 'takeable', 'idle'],
  properties: {
    format: { type: 'integer', const: 1 },
    at: { type: 'string', minLength: 1 },
    threshold_seconds: { type: 'integer', minimum: 0 },
    threshold_unknown: { type: 'string', minLength: 1 },
    takeable: { type: ['integer', 'null'], minimum: 0 },
    refused: { type: 'string', minLength: 1 },
    idle: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seat'],
        properties: {
          seat: { type: 'string', minLength: 1 },
          since: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** The green journal's ready-but-uninstalled metadata, as `status` and `check` print it. */
const GREEN_SLICES_SCHEMA_FRAGMENT = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'seat', 'commit', 'version', 'readyAt'],
    properties: {
      task: { type: 'string', minLength: 1 },
      seat: { type: 'string', minLength: 1 },
      commit: { type: 'string', minLength: 1 },
      version: { type: 'string', minLength: 1 },
      readyAt: { type: 'string', minLength: 1 },
    },
  },
} as const;

/** The native presence projection behind a seat reading (src/labels/state.ts): the canonical
 *  four-state word and its provenance, kept beside the legacy state word. */
const PRESENCE_PROVENANCE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'source', 'event', 'since', 'live'],
  properties: {
    state: { type: 'string', enum: ['working', 'idle', 'waiting-for-a-person', 'gone'] },
    source: { type: 'string', enum: ['runtime-hook', 'runtime-event', 'daemon-launch'] },
    event: { type: 'string', enum: ['turn-start', 'turn-end', 'human-wait', 'session-end'] },
    since: { type: 'string', minLength: 1 },
    live: { type: 'boolean' },
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
              seat_presence: PRESENCE_PROVENANCE_SCHEMA,
              seat_presence_unreadable: { type: 'boolean', const: true },
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
        pause: {
          type: 'object',
        },
        seat_pauses: {
          type: 'object',
        },
        procs: {
          type: 'array',
          items: { type: 'object' },
        },
        // A loose item here, like `hold`, `pause` and `procs`: the queued-swap fragments are
        // declared below this document, and a reference to them from here is a use before
        // initialization at module load.
        swaps: {
          type: 'array',
          items: { type: 'object' },
        },
        // The idle-with-work reading and the green journal, read by the status slice: each is
        // absent when the command did not read it.
        idle_work: IDLE_WORK_SCHEMA_FRAGMENT,
        green_slices: GREEN_SLICES_SCHEMA_FRAGMENT,
        green_notice: { type: 'string' },
        // The machine daemon's one health reading: the same snapshot the note line prints,
        // carried as one loose field like `hold` and `pause` above.
        daemon: { type: 'object' },
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
    pause: {
      type: 'object',
    },
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
          presence: PRESENCE_PROVENANCE_SCHEMA,
          presence_unreadable: { type: 'boolean', const: true },
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
          senderName: { type: 'string', enum: [...SENDER_NAME_MODES] },
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
    jules_only: { type: 'boolean' },
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
  required: ['format', 'project', 'session', 'key_isolation', 'warnings', 'repaired', 'notes', 'differences', 'summary'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    // The declared limitation of a client app key: the exact runtime line, never a claim of isolation.
    key_isolation: { type: 'string', minLength: 1 },
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
    // The same two readings `status` carries, and the rollout hint a stale brief leaves.
    idle_work: IDLE_WORK_SCHEMA_FRAGMENT,
    green_slices: GREEN_SLICES_SCHEMA_FRAGMENT,
    green_notice: { type: 'string' },
    hint: { type: 'string', minLength: 1 },
    // The same daemon reading `status` carries: notes and document from one derivation.
    daemon: { type: 'object' },
  },
};
/** Published `--json` output schema for `team client keygen` (`schema/client.schema.json`). */
export const CLIENT_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.client.keygen',
  fileName: 'client.schema.json',
  title: 'team client keygen --json output',
  required: ['format', 'status', 'key_path', 'public_key_path', 'key_dir', 'public_key', 'key_id', 'key_isolation'],
  properties: {
    format: { type: 'integer', const: 1 },
    status: { type: 'string', enum: ['created'] },
    key_path: { type: 'string', minLength: 1 },
    public_key_path: { type: 'string', minLength: 1 },
    key_dir: { type: 'string', minLength: 1 },
    public_key: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    key_id: { type: 'string', pattern: '^[0-9a-f]{12}$' },
    key_isolation: { type: 'string', minLength: 1 },
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
    notes: { type: 'array', items: { type: 'string' } },
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
  statuses: ['wrote', 'restored', 'requested', 'answered'],
  required: ['file', 'restored'],
  properties: {
    file: { type: 'string', minLength: 1 },
    restored: { type: 'boolean' },
    request_id: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    approved_by: { type: 'string' },
    rule_id: { type: 'string' },
    rules: { type: 'array', items: { type: 'object' } },
    ignored: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

/** Published `--json` output schema for `team grant` (`schema/grant.schema.json`). */
export const GRANT_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.grant',
  fileName: 'grant.schema.json',
  title: 'team grant --json output',
  statuses: ['updated', 'unchanged', 'dry-run', 'requested', 'denied'],
  required: ['project', 'session', 'target'],
  properties: {
    target: { type: 'string', minLength: 1 },
    approved_by: { type: 'string', minLength: 1 },
    rule_id: { type: 'string', minLength: 1 },
    request: { type: 'object' },
    summary: { type: 'object' },
    choices: { type: 'array', items: { type: 'object' } },
    prompt: { type: 'string' },
    rules: { type: 'array', items: { type: 'object' } },
    ignored: { type: 'array', items: { type: 'string' } },
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

/** One model a swap moves from or to: the file's words at queue time. */
const SWAP_MODEL_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cli', 'vendor', 'model', 'version', 'display'],
  properties: {
    cli: { type: 'string', minLength: 1 },
    vendor: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    display: { type: 'string', minLength: 1 },
  },
};

/** One queued swap: the record the watch carries out at the seat's boundary. */
const QUEUED_SWAP_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'reason', 'queuedAt', 'deadline', 'waitFor'],
  properties: {
    from: SWAP_MODEL_SCHEMA_FRAGMENT,
    to: {
      type: 'object',
      additionalProperties: false,
      required: ['cli', 'vendor', 'model', 'version', 'display', 'launch'],
      properties: {
        ...(SWAP_MODEL_SCHEMA_FRAGMENT.properties as Record<string, JsonSchema>),
        launch: { type: 'string', minLength: 1 },
        modelFrom: { type: 'string', const: 'launcher' },
        effort: { type: 'string', minLength: 1 },
        account: { type: 'string', minLength: 1 },
      },
    },
    reason: { type: 'string', enum: ['model-rule', 'config', 'owner'] },
    queuedAt: { type: 'string', minLength: 1 },
    deadline: { type: 'string', minLength: 1 },
    waitFor: { type: 'string', minLength: 1 },
    rule: { type: 'string' },
    handover: { type: 'string', minLength: 1 },
    forced: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'at'],
      properties: {
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
      },
    },
  },
};

/** Published `--json` output schema for `team swap` (`schema/swap.schema.json`). */
export const SWAP_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.swap',
  fileName: 'swap.schema.json',
  title: 'team swap --json output',
  statuses: ['listed', 'rule', 'queued', 'forced', 'ran', 'run-failed', 'cancelled'],
  required: ['project', 'session'],
  properties: {
    entity: { type: ['string', 'null'] },
    seat: { type: 'string', minLength: 1 },
    rule: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'allow', 'labs'],
        properties: {
          subject: { type: 'string', minLength: 1 },
          allow: { type: 'boolean' },
          labs: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    },
    teams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'root', 'visibility'],
        properties: {
          id: { type: ['string', 'null'] },
          name: { type: 'string', minLength: 1 },
          root: { type: 'string', minLength: 1 },
          visibility: { type: 'string', enum: ['public', 'private'] },
        },
      },
    },
    breaches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['team', 'root', 'visibility', 'seat', 'role', 'vendor', 'model', 'proposal', 'reason'],
        properties: {
          team: { type: 'string', minLength: 1 },
          root: { type: 'string', minLength: 1 },
          visibility: { type: 'string', enum: ['public', 'private'] },
          seat: { type: 'string', minLength: 1 },
          role: { type: 'string', minLength: 1 },
          vendor: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          proposal: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['donor', 'recipe'],
                properties: {
                  donor: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['team', 'root', 'seat'],
                    properties: {
                      team: { type: 'string', minLength: 1 },
                      root: { type: 'string', minLength: 1 },
                      seat: { type: 'string', minLength: 1 },
                    },
                  },
                  recipe: { type: 'object' },
                },
              },
            ],
          },
          reason: { type: ['string', 'null'] },
        },
      },
    },
    ignored: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'why'],
        properties: {
          root: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    swaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seat', 'swap'],
        properties: {
          seat: { type: 'string', minLength: 1 },
          swap: QUEUED_SWAP_SCHEMA_FRAGMENT,
        },
      },
    },
    swap: QUEUED_SWAP_SCHEMA_FRAGMENT,
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seat', 'result'],
        properties: {
          seat: { type: 'string', minLength: 1 },
          result: { type: 'string', enum: ['swapped', 'mismatch', 'failed', 'stays'] },
          old_pane: { type: 'string', minLength: 1 },
          pane: { type: 'string', minLength: 1 },
          read_back: { type: ['string', 'null'] },
          why: { type: 'string', minLength: 1 },
          resumed: { type: 'string', minLength: 1 },
          handover: { type: 'string', minLength: 1 },
        },
      },
    },
    donor: {
      type: 'object',
      additionalProperties: false,
      required: ['team', 'root', 'seat'],
      properties: {
        team: { type: 'string', minLength: 1 },
        root: { type: 'string', minLength: 1 },
        seat: { type: 'string', minLength: 1 },
      },
    },
  },
});

/** One stop point a pause records: the seat, and what its record and worktree held when the
 *  pause was written. Every field but the seat is absent when the tool held nothing for it. */
const PAUSE_STOP_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seat'],
  properties: {
    seat: { type: 'string', minLength: 1 },
    stage: { type: 'string', enum: ['launched', 'named', 'ready'] },
    branch: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    last_active: { type: 'string', minLength: 1 },
  },
};

/** Published `--json` output schema for `team pause` (`schema/pause.schema.json`). `target` is
 *  `team` for a team-wide pause and `seat` for one seat; `value` is the seat's name then, and the
 *  reason (or null) for a team-wide pause. */
export const PAUSE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.pause',
  fileName: 'pause.schema.json',
  title: 'team pause --json output',
  statuses: ['paused'],
  required: ['project', 'session', 'target', 'value', 'pause'],
  properties: {
    target: { type: 'string', enum: ['team', 'seat'] },
    value: { type: ['string', 'null'] },
    pause: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'at', 'stops'],
      properties: {
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
        stops: { type: 'array', items: PAUSE_STOP_SCHEMA_FRAGMENT },
      },
    },
  },
});

/** Published `--json` output schema for `team resume` (`schema/resume.schema.json`): the record
 *  that was cleared, stop points and all, so the caller keeps what the pause held. `target` is
 *  `team` for a team-wide resume and `seat` for one seat (`value` is its name); `still_paused`
 *  names the seats whose own records a team-wide resume left standing. */
export const RESUME_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.resume',
  fileName: 'resume.schema.json',
  title: 'team resume --json output',
  statuses: ['resumed'],
  required: ['project', 'session', 'target', 'value', 'resumed'],
  properties: {
    target: { type: 'string', enum: ['team', 'seat'] },
    value: { type: ['string', 'null'] },
    still_paused: { type: 'array', items: { type: 'string', minLength: 1 } },
    resumed: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'at', 'stops'],
      properties: {
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
        stops: { type: 'array', items: PAUSE_STOP_SCHEMA_FRAGMENT },
      },
    },
  },
});

/** Published `--json` output schema for `team raise` (`schema/raise.schema.json`). `record` is the
 *  owner mailbox record's id, null on a dry run; `count` is the record's reading after this call,
 *  so a merge shows the running total. */
export const RAISE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.raise',
  fileName: 'raise.schema.json',
  title: 'team raise --json output',
  statuses: ['raised', 'merged', 'dry-run'],
  required: ['project', 'session', 'kind', 'text', 'route', 'at', 'record', 'count'],
  properties: {
    kind: { type: 'string', enum: ['release.ready', 'decision.needed'] },
    text: { type: 'string', minLength: 1 },
    route: { type: 'string', const: 'owner' },
    record: { type: ['string', 'null'] },
    count: { type: 'integer', minimum: 1 },
    at: { type: 'string', minLength: 1 },
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

/** Published `--json` output schema for `team sessions` (`schema/sessions.schema.json`). */
export const SESSIONS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.sessions',
  fileName: 'sessions.schema.json',
  title: 'team sessions --json output',
  required: ['format', 'by', 'seat', 'sessions'],
  properties: {
    format: { type: 'integer', const: 1 },
    by: { type: ['string', 'null'], enum: ['model', 'team', 'entity', null] },
    seat: { type: ['string', 'null'] },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'seat', 'team', 'project', 'cli', 'lab', 'account', 'herdr_session', 'started', 'ended', 'reason'],
        properties: {
          id: { type: 'string', minLength: 1 },
          seat: { type: 'string', minLength: 1 },
          nickname: { type: 'string', minLength: 1 },
          team: { type: 'string', minLength: 1 },
          project: { type: 'string', minLength: 1 },
          entity: { type: 'string', minLength: 1 },
          cli: { type: 'string', minLength: 1 },
          lab: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          version: { type: 'string', minLength: 1 },
          effort: { type: 'string', minLength: 1 },
          account: { type: 'string', minLength: 1 },
          herdr_session: { type: 'string', minLength: 1 },
          pane: { type: 'string', minLength: 1 },
          workspace: { type: 'string', minLength: 1 },
          cli_session: { type: 'string', minLength: 1 },
          resumable: { type: 'boolean' },
          resume_until: { type: 'string', minLength: 1 },
          handover: { type: 'string', minLength: 1 },
          previous: { type: 'string', minLength: 1 },
          next: { type: 'string', minLength: 1 },
          started: { type: 'string', minLength: 1 },
          ended: { type: ['string', 'null'] },
          reason: {
            type: ['string', 'null'],
            enum: ['swap', 'restart', 'crash', 'owner-stop', 'quota', null],
          },
          note: { type: 'string', minLength: 1 },
          tokens: {
            type: 'object',
            additionalProperties: false,
            required: ['source'],
            properties: {
              in: { type: 'integer', minimum: 0 },
              out: { type: 'integer', minimum: 0 },
              cached: { type: 'integer', minimum: 0 },
              source: { type: 'string', enum: ['measured', 'estimated'] },
            },
          },
          cost: {
            type: 'object',
            additionalProperties: false,
            required: ['amount', 'currency', 'source'],
            properties: {
              amount: { type: 'number', minimum: 0 },
              currency: { type: 'string', minLength: 1 },
              source: { type: 'string', enum: ['measured', 'estimated'] },
            },
          },
          links: {
            type: 'object',
            additionalProperties: false,
            properties: {
              commits: { type: 'array', items: { type: 'string', minLength: 1 } },
              prs: { type: 'array', items: { type: 'string', minLength: 1 } },
              releases: { type: 'array', items: { type: 'string', minLength: 1 } },
            },
          },
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

/** Published `--json` output schema for `team queue` (`schema/queue.schema.json`). */
export const QUEUE_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.queue',
  fileName: 'queue.schema.json',
  title: 'team queue --json output',
  required: ['format', 'project', 'session', 'source', 'path', 'tasks'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    // `local` is the fallback queue; `file` is the path the owner's tasks section names.
    source: { type: 'string', enum: ['local', 'file'] },
    path: { type: 'string', minLength: 1 },
    // Present on an add alone: `present` means the same record was already queued and nothing was written.
    status: { type: 'string', enum: ['added', 'present'] },
    task: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'assignee'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        assignee: { type: ['string', 'null'] },
        priority: { type: ['string', 'number'] },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'assignee'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          assignee: { type: ['string', 'null'] },
          priority: { type: ['string', 'number'] },
        },
      },
    },
  },
};

export const GREEN_SLICE_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.green-slice',
  fileName: 'green-slice.schema.json',
  title: 'team queue ready|install --json output',
  required: ['format', 'project', 'session', 'action', 'status', 'event'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['ready', 'install'] },
    // `held` means the same task, commit and version was already recorded; nothing was written.
    status: { type: 'string', enum: ['recorded', 'held'] },
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'task', 'commit', 'version', 'at'],
      properties: {
        kind: { type: 'string', enum: ['ready', 'install'] },
        task: { type: 'string', minLength: 1 },
        commit: { type: 'string', minLength: 7, maxLength: 40 },
        version: { type: 'string', minLength: 1 },
        // A ready event names the seat; an install event names the installer that acknowledged it.
        seat: { type: 'string', minLength: 1 },
        installedBy: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
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
      // Two shapes, one timeline. A message event keeps exactly the fields it had; a presence
      // transition is its own typed event — the canonical words, the binding, both sequences and
      // both ids — and carries no `from`, `to` or `body`, because a state is not a message.
      items: {
        oneOf: [
          {
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
              // The team the sender stood in, by team id, on a line a send of this version wrote: the
              // feed reads a cross-team sender by its address from it, and prints the plain seat name
              // for a line without one.
              from_team: { type: 'string' },
              // Present only on a line the sender measured, as the history log writes it.
              ms: { type: 'number' },
              via: { type: 'string' },
              failed: { type: 'array', items: { type: 'string' } },
              // The qualifier on an outcome the plain word cannot carry alone, as the history log
              // writes it (`trigger taken, no read receipt yet` on a typed send; `taken but never acted on`).
              note: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: [
              'kind', 'ts', 'session', 'seat', 'state', 'event', 'source', 'binding',
              'seq', 'presence_seq', 'event_id', 'observed_at', 'id',
            ],
            properties: {
              kind: { type: 'string', const: 'presence.changed' },
              // The runtime event's own instant, the seat's session, and the seat it concerns.
              ts: { type: 'string' },
              session: { type: 'string' },
              seat: { type: 'string' },
              state: { type: 'string', enum: [...PRESENCE_STATES] },
              event: { type: 'string', enum: [...PRESENCE_EVENTS] },
              source: { type: 'string', enum: [...PRESENCE_WRITER_SOURCES] },
              // The launch binding the transition was written under.
              binding: { type: 'string' },
              // The bus log's sequence, and the per-seat presence log's own.
              seq: { type: 'integer' },
              presence_seq: { type: 'integer' },
              // The runtime event's id, and the publisher's derived record id.
              event_id: { type: 'string' },
              observed_at: { type: 'string' },
              id: { type: 'string' },
            },
          },
        ],
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
    /** Present and true when `--no-launch` left the general seat brief out. */
    no_launch: { type: 'boolean', const: true },
    notes: { type: 'array', items: { type: 'string' } },
    restore_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['repaired', 'skipped_working', 'refused', 'repaired_seats', 'skipped_working_seats', 'refused_seats', 'line'],
      properties: {
        repaired: { type: 'integer', minimum: 0 },
        skipped_working: { type: 'integer', minimum: 0 },
        refused: { type: 'integer', minimum: 0 },
        repaired_seats: { type: 'array', items: { type: 'string', minLength: 1 } },
        skipped_working_seats: { type: 'array', items: { type: 'string', minLength: 1 } },
        refused_seats: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['seat', 'reason'],
            properties: {
              seat: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1 },
            },
          },
        },
        line: { type: 'string', minLength: 1 },
      },
    },
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

/** Published `--json` output schema for the client read
 *  (`schema/messages-client.schema.json`): the `team.messages.client` document, rows and the
 *  optional ack fact. It carries the key-isolation line the invocation always declares. */
export const CLIENT_MESSAGES_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.messages.client',
  fileName: 'messages-client.schema.json',
  title: 'team messages --client --json output',
  required: ['format', 'project', 'session', 'client', 'rows', 'notes', 'differences', 'summary', 'counts', 'key_isolation'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    client: { type: 'string', minLength: 1 },
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
    // Present when the read named `--ack`: the receipt's own outcome, including the idempotent
    // repeat (`already-acked`) and a receipt that does not verify (`refused`).
    ack: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'written'],
      properties: {
        id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['acknowledged', 'already-acked', 'refused'] },
        written: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    key_isolation: { type: 'string', minLength: 1 },
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

/** Published `--json` output schema for `team brief rollout` (`schema/brief.schema.json`): one
 *  row per declared seat — the action the plan takes or the outcome `--apply` reached — and the
 *  counts of those rows. `current` is delivery currency, never a read. */
export const BRIEF_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.brief',
  fileName: 'brief.schema.json',
  title: 'team brief rollout --json output',
  required: ['format', 'project', 'session', 'apply', 'seats', 'counts'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    apply: { type: 'boolean' },
    seats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seat', 'action', 'hash12', 'id', 'from', 'reason', 'current'],
        properties: {
          seat: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['current', 'deliver', 'recover', 'recovered', 'not-running', 'human', 'stale-listener', 'failed'] },
          // The delivered brief's digest, first twelve hex digits; null when the row names none.
          hash12: { type: ['string', 'null'] },
          id: { type: ['string', 'null'] },
          // The id a recovery moves past: the name that is not this brief's.
          from: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
          current: { type: 'boolean' },
        },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['current', 'deliver', 'recover', 'not_running', 'human', 'stale_listener', 'failed'],
      properties: {
        current: { type: 'integer', minimum: 0 },
        deliver: { type: 'integer', minimum: 0 },
        recover: { type: 'integer', minimum: 0 },
        not_running: { type: 'integer', minimum: 0 },
        human: { type: 'integer', minimum: 0 },
        stale_listener: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
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

/** Published `--json` output schema for `team ack` (`schema/ack.schema.json`): the one written
 *  outcome, a signed read receipt marked for the message's addressee. `written` is false when
 *  another reader's valid receipt already served the id, which is still a read. */
export const ACK_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.ack',
  fileName: 'ack.schema.json',
  title: 'team ack --json output',
  required: ['format', 'status', 'action_summary', 'project', 'session', 'record', 'to', 'thread', 'written', 'at'],
  properties: {
    format: { type: 'integer', const: 1 },
    status: { type: 'string', enum: ['read'] },
    action_summary: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    record: { type: 'string', minLength: 1 },
    // The record's addressee, whose folder holds the receipt.
    to: { type: 'string', minLength: 1 },
    thread: { type: 'string', minLength: 1 },
    written: { type: 'boolean' },
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
        status: { type: 'string', enum: ['delivered', 'delivered (read)', 'sent (unconfirmed)', 'queued (receiver busy)', 'answered', 'recorded', 'native', 'dry-run'] },
        action_summary: { type: 'string', minLength: 1 },
        project: { type: ['string', 'null'] },
        session: { type: ['string', 'null'] },
        seat: { type: 'string', minLength: 1 },
        channel: { type: ['string', 'null'], enum: ['socket', 'typed', 'drop', 'mcp-inbox', 'native', 'headless-resume', null] },
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
        thread: { type: ['string', 'null'] },
        reply: { type: 'string' },
        address: { type: ['string', 'null'] },
        plan: { type: 'array', items: PLAN_STEP_SCHEMA_FRAGMENT },
        delivery: DELIVERY_LEGS_SCHEMA_FRAGMENT,
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


/** Published `--json` output schema for `team settings <seat>` (`schema/settings.schema.json`):
 *  one row per registered setting, each with the value and the level it came from. */
export const SETTINGS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.settings',
  fileName: 'settings.schema.json',
  title: 'team settings <seat> --json output',
  required: ['format', 'project', 'seat', 'settings'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    seat: { type: 'string', minLength: 1 },
    settings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'source', 'applies'],
        properties: {
          key: { type: 'string', enum: [...CONFIG_KEYS] },
          value: {
            type: ['string', 'boolean', 'array', 'null'],
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          source: { type: 'string', enum: CONFIG_SOURCE_WORDS },
          applies: { type: 'string', enum: ['restart-resume', 'at-once'] },
          source_file: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team settings set|unset` (`schema/settings-change.schema.json`):
 *  the setting a write records or removes, at the seat it lands on. */
export const SETTINGS_CHANGE_OUTPUT_SCHEMA: CommandSchemaSpec = buildActionSchemaSpec({
  name: 'team.settings-change',
  fileName: 'settings-change.schema.json',
  title: 'team settings set|unset --json output',
  statuses: ['dry-run', 'updated', 'unset'],
  required: ['level', 'target', 'seat', 'settings'],
  properties: {
    level: { type: 'string', enum: [...CONFIG_LEVELS] },
    target: { type: 'string', minLength: 1 },
    seat: { type: 'string', minLength: 1 },
    settings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'old', 'applies'],
        properties: {
          key: { type: 'string', enum: [...CONFIG_KEYS] },
          value: {
            type: ['string', 'boolean', 'array', 'null'],
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          old: {
            type: ['string', 'boolean', 'array', 'null'],
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          applies: { type: 'string', enum: ['restart-resume', 'at-once'] },
        },
      },
    },
  },
});

/** Published `--json` output schema for `team config keys` (`schema/config-keys.schema.json`):
 *  the registry as the command lists it, one entry per key. */
export const CONFIG_KEYS_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.config-keys',
  fileName: 'config-keys.schema.json',
  title: 'team config keys --json output',
  required: ['format', 'level', 'keys'],
  properties: {
    format: { type: 'integer', const: 1 },
    level: { type: ['string', 'null'], enum: [...CONFIG_LEVELS, null] },
    keys: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'levels', 'type', 'allowed', 'default', 'governed_by', 'applies'],
        properties: {
          key: { type: 'string', enum: [...CONFIG_KEYS] },
          levels: { type: 'array', items: { type: 'string', enum: [...CONFIG_LEVELS] } },
          type: { type: 'string', enum: ['model', 'effort', 'nickname', 'order', 'boolean'] },
          allowed: { type: 'string', minLength: 1 },
          default: {
            type: ['string', 'boolean', 'array', 'null'],
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          governed_by: { type: ['string', 'null'] },
          applies: { type: 'string', enum: ['restart-resume', 'at-once'] },
        },
      },
    },
  },
};

/** Published `--json` output schema for `team seat <seat>` (`schema/seat.schema.json`): the seat's
 *  settings, the row `team seats` reads for it, its last turn and its newest session. */
export const SEAT_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.seat',
  fileName: 'seat.schema.json',
  title: 'team seat <seat> --json output',
  required: ['format', 'project', 'session', 'seat', 'settings', 'status', 'turn', 'conversation'],
  properties: {
    format: { type: 'integer', const: 1 },
    project: { type: 'string', minLength: 1 },
    session: { type: 'string', minLength: 1 },
    seat: { type: 'string', minLength: 1 },
    settings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'source', 'applies'],
        properties: {
          key: { type: 'string', enum: [...CONFIG_KEYS] },
          value: {
            type: ['string', 'boolean', 'array', 'null'],
            items: { type: 'string', enum: [...DELIVERY_LEGS] },
          },
          source: { type: 'string', enum: CONFIG_SOURCE_WORDS },
          applies: { type: 'string', enum: ['restart-resume', 'at-once'] },
          source_file: { type: 'string', minLength: 1 },
        },
      },
    },
    status: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'nickname', 'id', 'role', 'cli', 'model', 'effort', 'status', 'state', 'state_source', 'last_active', 'pane', 'launch_line'],
      properties: {
        name: { type: 'string', minLength: 1 },
        nickname: { type: ['string', 'null'] },
        id: { type: ['string', 'null'] },
        role: { type: 'string', minLength: 1 },
        cli: { type: 'string', minLength: 1 },
        model: { type: ['string', 'null'] },
        effort: { type: ['string', 'null'] },
        status: { type: 'string', minLength: 1 },
        state: { type: 'string', minLength: 1 },
        state_source: { type: 'string', minLength: 1 },
        blind: { type: 'boolean', const: true },
        last_active: { type: ['string', 'null'] },
        pane: { type: ['string', 'null'] },
        launch_line: { type: ['string', 'null'] },
        presence: PRESENCE_PROVENANCE_SCHEMA,
        presence_unreadable: { type: 'boolean', const: true },
      },
    },
    turn: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['state', 'since'],
      properties: {
        state: { type: 'string', enum: ['working', 'idle'] },
        since: { type: 'string', minLength: 1 },
      },
    },
    conversation: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['id', 'started', 'ended', 'reason'],
      properties: {
        id: { type: 'string', minLength: 1 },
        cli_session: { type: 'string', minLength: 1 },
        resumable: { type: 'boolean' },
        resume_until: { type: 'string', minLength: 1 },
        handover: { type: 'string', minLength: 1 },
        previous: { type: 'string', minLength: 1 },
        started: { type: 'string', minLength: 1 },
        ended: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
      },
    },
    cost: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'currency', 'source'],
      properties: {
        amount: { type: 'number', minimum: 0 },
        currency: { type: 'string', minLength: 1 },
        source: { type: 'string', enum: ['measured', 'estimated'] },
      },
    },
    tokens: {
      type: 'object',
      additionalProperties: false,
      required: ['in', 'out', 'source'],
      properties: {
        in: { type: 'integer', minimum: 0 },
        out: { type: 'integer', minimum: 0 },
        source: { type: 'string', enum: ['measured', 'estimated'] },
      },
    },
  },
};

const WORKFLOW_DEFINITION_ID_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'schemaVersion', 'digest'],
  properties: {
    workflow: { type: 'string', minLength: 1 },
    schemaVersion: { type: 'integer', const: 1 },
    digest: { type: 'string', minLength: 1 },
  },
};

const WORKFLOW_DRY_EFFECT_SCHEMA_FRAGMENT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'state', 'activation', 'occurrence', 'payloadDigest', 'dispatched'],
  properties: {
    name: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
    activation: { type: 'integer', minimum: 1 },
    occurrence: { type: 'string', minLength: 1 },
    payloadDigest: { type: 'string', minLength: 1 },
    outcome: { type: 'string', minLength: 1 },
    dispatched: { type: 'boolean', const: false },
  },
};

/** Published `--json` output schema for `team workflow` (`schema/workflow.schema.json`). */
export const WORKFLOW_OUTPUT_SCHEMA: CommandSchemaSpec = {
  name: 'team.workflow',
  fileName: 'workflow.schema.json',
  title: 'team workflow --json output',
  required: [],
  properties: {},
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'ok', 'path', 'definition', 'findings', 'summary'],
      properties: {
        schema: schemaTagFragment('team.workflow', 1),
        format: { type: 'integer', const: 1 },
        ok: { type: 'boolean' },
        path: { type: 'string', minLength: 1 },
        definition: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['workflow', 'schemaVersion', 'digest'],
          properties: {
            workflow: { type: 'string', minLength: 1 },
            schemaVersion: { type: 'integer', const: 1 },
            digest: { type: 'string', minLength: 1 },
          },
        },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'level', 'line', 'message'],
            properties: {
              code: { type: 'string', minLength: 1 },
              level: { type: 'string', enum: ['refusal', 'note'] },
              line: { type: 'integer', minimum: 0 },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
        summary: {
          type: 'object',
          additionalProperties: false,
          required: ['refusals', 'notes'],
          properties: {
            refusals: { type: 'integer', minimum: 0 },
            notes: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'format',
        'kind',
        'authoritative',
        'notice',
        'definition',
        'run',
        'target',
        'artifact',
        'inputs',
        'settings',
        'initial',
        'start',
        'steps',
        'outcome',
      ],
      properties: {
        format: { type: 'integer', const: 1 },
        kind: { type: 'string', const: 'workflow-run-dry' },
        authoritative: { type: 'boolean', const: false },
        notice: { type: 'string', const: 'dry run — no record is written' },
        definition: WORKFLOW_DEFINITION_ID_SCHEMA_FRAGMENT,
        run: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        artifact: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['none', 'ref', 'tree'] },
            value: { type: 'string', minLength: 1 },
          },
        },
        inputs: { type: 'object' },
        settings: { type: 'object' },
        initial: { type: 'string', minLength: 1 },
        start: {
          type: 'object',
          additionalProperties: false,
          required: ['state', 'activation', 'effects'],
          properties: {
            state: { type: 'string', minLength: 1 },
            activation: { type: 'integer', const: 1 },
            effects: {
              type: 'array',
              items: WORKFLOW_DRY_EFFECT_SCHEMA_FRAGMENT,
            },
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'revision',
              'at',
              'signal',
              'requestId',
              'requestDigest',
              'transition',
              'activation',
              'evidence',
              'effects',
            ],
            properties: {
              revision: { type: 'integer', minimum: 1 },
              at: { type: 'string', minLength: 1 },
              signal: { type: 'string', minLength: 1 },
              requestId: { type: 'string', minLength: 1 },
              requestDigest: { type: 'string', minLength: 1 },
              transition: {
                type: 'object',
                additionalProperties: false,
                required: ['from', 'to', 'on'],
                properties: {
                  from: { type: 'string', minLength: 1 },
                  to: { type: 'string', minLength: 1 },
                  on: { type: 'string', minLength: 1 },
                },
              },
              activation: { type: 'integer', minimum: 2 },
              evidence: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
              },
              guard: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'answer', 'evidence'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  answer: { type: 'boolean' },
                  evidence: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                  },
                },
              },
              effects: {
                type: 'array',
                items: WORKFLOW_DRY_EFFECT_SCHEMA_FRAGMENT,
              },
            },
          },
        },
        outcome: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['script-exhausted', 'stopped'] },
            decision: { type: 'string', enum: ['held', 'refused'] },
            code: { type: 'string', minLength: 1 },
            why: { type: 'string', minLength: 1 },
            at: { type: 'string', minLength: 1 },
            state: { type: 'string', minLength: 1 },
            revision: { type: 'integer', minimum: 0 },
            waitingOn: { type: 'object' },
            signal: { type: 'string', minLength: 1 },
            requestId: { type: 'string', minLength: 1 },
            expectedRevision: { type: 'integer', minimum: 0 },
            evidence: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
            },
            guard: { type: 'object' },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'format', 'kind', 'authoritative', 'notice', 'ok'],
      properties: {
        schema: schemaTagFragment('team.workflow', 1),
        format: { type: 'integer', const: 1 },
        kind: { type: 'string', const: 'workflow-replay' },
        authoritative: { type: 'boolean', const: false },
        notice: { type: 'string', const: 'dry run — no record is written' },
        ok: { type: 'boolean' },
        definition: WORKFLOW_DEFINITION_ID_SCHEMA_FRAGMENT,
        run: { type: 'string', minLength: 1 },
        stepsReplayed: { type: 'integer', minimum: 0 },
        finalState: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        activation: { type: 'integer', minimum: 1 },
        blocked: { type: ['object', 'null'] },
        reason: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'why'],
          properties: {
            code: { type: 'string', minLength: 1 },
            why: { type: 'string', minLength: 1 },
            step: { type: 'integer', minimum: -1 },
            expected: {},
            actual: {},
          },
        },
      },
    },
  ],
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
  CLIENT_OUTPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  GRANT_OUTPUT_SCHEMA,
  DELEGATE_OUTPUT_SCHEMA,
  REVOKE_OUTPUT_SCHEMA,
  HOLD_OUTPUT_SCHEMA,
  SWAP_OUTPUT_SCHEMA,
  PAUSE_OUTPUT_SCHEMA,
  RESUME_OUTPUT_SCHEMA,
  RAISE_OUTPUT_SCHEMA,
  LOCK_OUTPUT_SCHEMA,
  UNLOCK_OUTPUT_SCHEMA,
  RELEASE_OUTPUT_SCHEMA,
  POLICY_OUTPUT_SCHEMA,
  ISSUES_OUTPUT_SCHEMA,
  SESSIONS_OUTPUT_SCHEMA,
  FEED_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  QUEUE_OUTPUT_SCHEMA,
  GREEN_SLICE_OUTPUT_SCHEMA,
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
  CLIENT_MESSAGES_OUTPUT_SCHEMA,
  DROPS_OUTPUT_SCHEMA,
  BRIEF_OUTPUT_SCHEMA,
  ROUTE_OUTPUT_SCHEMA,
  SEND_OUTPUT_SCHEMA,
  REPLY_OUTPUT_SCHEMA,
  ACK_OUTPUT_SCHEMA,
  ANSWER_OUTPUT_SCHEMA,
  MCP_OUTPUT_SCHEMA,
  TEMPO_OUTPUT_SCHEMA,
  PROC_OUTPUT_SCHEMA,
  WORKTREE_OUTPUT_SCHEMA,
  COMMITS_OUTPUT_SCHEMA,
  PR_OUTPUT_SCHEMA,
  USAGE_OUTPUT_SCHEMA,
  SETTINGS_OUTPUT_SCHEMA,
  SETTINGS_CHANGE_OUTPUT_SCHEMA,
  CONFIG_KEYS_OUTPUT_SCHEMA,
  SEAT_OUTPUT_SCHEMA,
  WORKFLOW_OUTPUT_SCHEMA,
];


