import { isAbsolute } from 'node:path';
import { CLIS } from '../../clis.ts';
import { shippedEfforts } from '../../profiles/efforts.ts';
import { FRONTS, REACH_ALIAS, REACH_MAX_SEATS, REACH_ROUTE } from '../../reach/rules.ts';
import type { YamlEntry } from '../../yaml.ts';
import { insideProject, insideTrust, normalize } from '../paths.ts';
import { hasVersionToken } from '../signature.ts';
import type { Check } from '../check.ts';
import type { Mode, Seat, SeatReach } from '../types.ts';
import type { LeadMark, Section } from './section.ts';
import { valueOf } from './section.ts';
import type { Budgeted } from './budgets.ts';
import { MODES } from './workspace.ts';

export type DraftSeat = Omit<Seat, 'mode'> & { mode?: Mode };

/** The team file's own seat-name rule: a letter or digit first, then letters, digits, `.`, `_`
 *  and `-`. Everything that builds a path out of a seat name holds itself to the same rule —
 *  there is no second, looser one. */
export const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const seats: Section = {
  name: 'seats',
  owner: false,
  after: ['trust', 'budgets'],
  validate(entry, ctx) {
    const trust = valueOf<string[]>(ctx, 'trust');
    const accounts = valueOf<Budgeted>(ctx, 'budgets').declared;
    const marks: LeadMark[] = [];
    const seats = readSeats(entry, ctx.check, trust, ctx.root.line, ctx.broken, accounts, marks);
    ctx.leads = marks;
    return seats;
  },
  schema: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', minLength: 1 },
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
        cli: { enum: CLIS },
        vendor: { type: 'string', minLength: 1 },
        account: { type: 'string' },
        model_from: { enum: ['launcher'], $comment: 'the model is chosen by the launcher; doctor checks the running seat' },
        model: { type: 'string', minLength: 1 },
        version: { type: 'string', $comment: 'quoted: unquoted, YAML reads 4.10 as the number 4.1' },
        display: { type: 'string', $comment: 'defaults to "model version"; must contain the version as a token of its own' },
        launch: { type: 'string', minLength: 1 },
        cwd: { type: 'string', $comment: 'relative to the project, or a trust path' },
        label: { type: 'string', $comment: 'the workspace title when written; left out, the title is the seat name and its role, and this stored value stays the model and version in lowercase' },
        effort: { type: 'string', minLength: 1, $comment: 'optional; a lab with a vocabulary warns when the word is outside it, and check still passes; launch does not read it' },
        mode: { enum: MODES },
        parked: { type: 'boolean' },
        stopped: { type: 'boolean' },
        leads: { type: 'boolean', $comment: 'the seat that leads: exactly one seat carries it' },
        count: { type: 'integer', minimum: 1 },
        reach: {
          type: 'object',
          additionalProperties: false,
          properties: {
            to: { type: 'array', minItems: 1, items: { enum: FRONTS }, $comment: 'the fronts this seat may be reached from; owner-only, default off' },
            alias: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', $comment: 'the projection alias; defaults to the name, lowercased' },
            route: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', $comment: 'the bridge\'s relay-side route; defaults to the alias' },
            key_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', $comment: 'defaults to seat-<alias>-1' },
            guard_dir: { type: 'string', minLength: 1, $comment: 'absolute; where the seat\'s public key is read; defaults to <lobby>/guard-floor-<alias>' },
          },
          required: ['to'],
          $comment: 'one seat\'s reach grant; projected into reach-roster.json by up, add and remove (src/reach/projection.ts)',
        },
      },
      required: ['role', 'name', 'cli', 'vendor', 'model', 'version', 'launch'],
      $comment: 'account must name a key of budgets.accounts; the workspace title is the written label, or the seat name and role when none is written; display and effort are the pane display; a seat with count is neither lead',
    },
  },
};

// `broken` collects the names of seats left out for their own problems, so that a reference to
// one is not reported a second time. `accounts` is the names the file's budgets declare: a seat
// that names an `account:` must name one of these, or it would silently spend nothing budgeted.
function readSeats(
  entry: YamlEntry | undefined, check: Check, trust: string[], topLine: number, broken: Set<string>, accounts: ReadonlySet<string>,
  marks: LeadMark[],
): DraftSeat[] {
  if (!entry) {
    check.fail(topLine, 'seats is required: at least the orchestrator\'s and the operator\'s seat');
    return [];
  }
  if (entry.value.kind !== 'seq' || !entry.value.items.length) {
    check.fail(entry.value.line, 'seats must be a list with at least one seat');
    return [];
  }
  const seats: DraftSeat[] = [];
  for (const item of entry.value.items) {
    const fields = check.fields(item, 'a seat', [
      'role', 'name', 'cli', 'vendor', 'account', 'model_from', 'model', 'version', 'display', 'launch', 'cwd', 'label', 'effort', 'mode',
      'parked', 'stopped', 'count', 'leads', 'reach',
    ]);
    if (item.kind !== 'map') continue;
    const line = item.line;
    const role = check.required(fields.get('role'), 'a seat\'s role', line);
    const name = check.required(fields.get('name'), 'a seat\'s name', line);
    const at = name ? `seat "${name}"` : 'a seat';
    if (name && !SEAT_NAME.test(name)) {
      check.fail(fields.get('name')?.line ?? line, `${at}: the name takes letters, digits, ".", "_" and "-"`);
    }
    if (!fields.get('cli')) check.fail(line, `${at}: cli is required`);
    const cli = check.oneOf(fields.get('cli'), `${at}: cli`, CLIS);
    const vendor = check.required(fields.get('vendor'), `${at}: vendor`, line);
    // The account whose budget the seat spends, when the vendor's name is not it (§ 3b). Optional:
    // absent, the seat spends its vendor, and the fingerprint of every file written so far is
    // unchanged. Named, it must be one of the budgets' accounts: a typo would take the seat out of
    // every budget with no warning at all.
    const account = check.text(fields.get('account'), `${at}: account`);
    if (account !== undefined && !accounts.has(account)) {
      check.fail(fields.get('account')?.line ?? line, `${at}: account "${account}" is not in budgets.accounts`);
    }
    // `launcher` says the model is chosen by whatever the launch line runs; `doctor` then checks
    // the running seat instead of the launch. It is in the seat's digest: writing it is a change
    // the owner approves.
    const modelFrom = check.oneOf(fields.get('model_from'), `${at}: model_from`, ['launcher']);
    const model = check.required(fields.get('model'), `${at}: model`, line);
    const version = readVersion(fields.get('version'), at, line, check);
    const launch = check.required(fields.get('launch'), `${at}: launch`, line);
    const display = check.text(fields.get('display'), `${at}: display`) ?? (model && version ? `${model} ${version}` : undefined);
    if (display && version && fields.get('display') && !hasVersionToken(display, version)) {
      check.fail(fields.get('display')?.line ?? line, `${at}: display must contain the version "${version}" as a token of its own`);
    }
    const cwd = readCwd(fields.get('cwd'), at, trust, check);
    const mode = check.oneOf(fields.get('mode'), `${at}: mode`, MODES);
    const parked = check.flag(fields.get('parked'), `${at}: parked`);
    const stopped = check.flag(fields.get('stopped'), `${at}: stopped`);
    // Beside parked and stopped: an unquoted boolean, and `false` reads as absent. The mark is
    // handed to the lead's section through the context, never onto a seat: `seatDigest` hashes
    // every field outside its free set, so a `leads` field on a built seat would make a marked
    // file differ from the keyed file of the same team.
    const leadsField = fields.get('leads');
    const leads = check.flag(leadsField, `${at}: leads`);
    if (leads && name && leadsField) marks.push({ name, line: leadsField.value.line });
    const count = check.whole(fields.get('count'), `${at}: count`, 1) ?? 1;
    const label = check.text(fields.get('label'), `${at}: label`);
    const effort = readEffort(fields.get('effort'), at, vendor, check);
    // The written label, or the lowercase model and version, stays on the seat: `seatDigest`
    // hashes `label`, and an approved file keeps its key. `labelWritten` is not hashed: it only
    // records that the file wrote the field, so `workspaceLabel` can tell the two apart.
    // The owner-only reach grant. In the seat's digest like every other field: a grant reaches
    // the bridge and the shuttle daemon only through an owner's approval of the file.
    const reach = readReach(fields.get('reach'), at, check);
    if (!role || !name || !cli || !vendor || !model || !version || !launch || !display) {
      if (name) broken.add(name);
      continue;
    }
    for (let instance = 1; instance <= count; instance++) {
      const suffix = instance === 1 ? '' : `-${instance}`;
      seats.push({
        role, cli, vendor, model, version, display, launch, cwd, parked, stopped, line,
        name: name + suffix,
        label: (label ?? defaultLabel(model, version)) + suffix,
        ...(label !== undefined ? { labelWritten: true as const } : {}),
        declared: name,
        count,
        instance,
        ...(account ? { account } : {}),
        // Omitted when the file has no effort, so `seatDigest` hashes the same fields as before.
        ...(effort ? { effort } : {}),
        ...(modelFrom ? { modelFrom } : {}),
        ...(mode ? { mode } : {}),
        ...(reach ? { reach } : {}),
      });
    }
  }
  reportCollisions(seats, 'name', check);
  reportReach(seats, check);
  return seats;
}

export function defaultLabel(model: string, version: string): string {
  return `${model} ${version}`.toLowerCase();
}

/**
 * Line 1, the herdr workspace title `up` and `add` give a seat. A written label is that
 * title, and a `count` instance after the first already carries `-<n>` on the stored label
 * (the same suffix as its name), so the lines differ. A seat with no written label is
 * `<name> · <role>`; count instances already have distinct names. The model is never the title.
 */
export function workspaceLabel(seat: { name: string; role: string; label: string; labelWritten?: boolean }): string {
  if (seat.labelWritten) return seat.label;
  return `${seat.name} · ${seat.role}`;
}

/** Line 2's display_agent: the display, and a space plus the effort when the file sets one. Herdr writes the status word and ` · ` in front of this text. */
export function displayAgent(seat: { display: string; effort?: string }): string {
  return seat.effort ? `${seat.display} ${seat.effort}` : seat.display;
}

function readEffort(
  entry: YamlEntry | undefined, at: string, vendor: string | undefined, check: Check,
): string | undefined {
  const effort = check.text(entry, `${at}: effort`);
  if (effort === undefined || !entry || !vendor) return effort;
  // Launch does not read `effort`. The word stays on the seat either way, so a later label can
  // see what the file wrote, and the approval key changes when the field is added.
  // The vocabulary is read only once a seat sets the field, so a file that omits it opens
  // nothing new and cannot fail because the list is missing.
  const efforts = shippedEfforts();
  if (!efforts.ok) {
    check.warnings.push({ line: entry.value.line, message: efforts.message });
    return effort;
  }
  const allowed = efforts.labs[vendor];
  // A lab with no entry accepts any word: the vocabulary leaves that lab out rather than invent
  // one. A lab with a list warns and names its words. The warning does not fail check, approve
  // or up. No file that loaded before can contain `effort` — an unknown field already fails —
  // so the warning is not a regression for those files.
  if (allowed && !allowed.includes(effort)) {
    check.warnings.push({
      line: entry.value.line,
      message: `${at}: effort "${effort}" is not one of ${vendor}'s: ${allowed.join(', ')}`,
    });
  }
  return effort;
}

function readVersion(entry: YamlEntry | undefined, at: string, line: number, check: Check): string | undefined {
  if (!entry) {
    check.fail(line, `${at}: version is required`);
    return undefined;
  }
  const node = entry.value;
  if (node.kind === 'scalar' && typeof node.value === 'string' && node.value !== '') return node.value;
  if (node.kind === 'scalar' && typeof node.value === 'number') {
    check.fail(node.line, `${at}: version must be quoted ("${node.raw}"): unquoted, YAML reads it as a number and 4.10 becomes 4.1`);
  } else check.fail(node.line, `${at}: version must be quoted text`);
  return undefined;
}

function readCwd(entry: YamlEntry | undefined, at: string, trust: string[], check: Check): string {
  const cwd = check.text(entry, `${at}: cwd`);
  if (cwd === undefined || !entry) return '.';
  if (/[\x00-\x1f\x7f`]/.test(cwd)) {
    check.fail(entry.value.line, `${at}: cwd must not contain control characters or backticks`);
    return '.';
  }
  if (cwd.startsWith('/') || cwd.startsWith('~') || /^[A-Za-z]:[\\/]/.test(cwd)) {
    check.fail(entry.value.line, `${at}: cwd must be relative to the project, never absolute and never "~"`);
    return '.';
  }
  const path = normalize(cwd);
  if (!insideProject(path) && !insideTrust(path, trust)) {
    check.fail(entry.value.line, `${at}: cwd "${cwd}" is outside the project and matches no trust path`);
  }
  return path;
}

function reportCollisions(seats: DraftSeat[], field: 'name', check: Check): void {
  const seen = new Map<string, DraftSeat>();
  for (const seat of seats) {
    const first = seen.get(seat[field]);
    if (!first) seen.set(seat[field], seat);
    else if (first.line !== seat.line || first.instance === seat.instance) {
      check.fail(seat.line, `two seats have the ${field} "${seat[field]}" (the other is on line ${first.line}${first.count > 1 || seat.count > 1 ? ', after count is expanded' : ''})`);
    }
  }
}

// The reach grant as written. Only `to` is required: the other four have one default each, and
// the projection is where they are filled in (`src/reach/projection.ts`), so a default can never
// drift between the digest — which holds exactly what the file wrote — and the projection.
function readReach(entry: YamlEntry | undefined, at: string, check: Check): SeatReach | undefined {
  if (!entry) return undefined;
  const fields = check.fields(entry.value, `${at}: reach`, ['to', 'alias', 'route', 'key_id', 'guard_dir']);
  const to: string[] = [];
  const toEntry = fields.get('to');
  if (!toEntry) {
    if (entry.value.kind === 'map' || (entry.value.kind === 'scalar' && entry.value.value === null)) {
      check.fail(entry.value.line, `${at}: reach.to is required: at least one front`);
    }
  } else {
    const items = check.list(toEntry, `${at}: reach.to`);
    if (items.length === 0 && (toEntry.value.kind === 'seq' || (toEntry.value.kind === 'scalar' && toEntry.value.value === null))) {
      check.fail(toEntry.value.line, `${at}: reach.to is required: at least one front`);
    }
    for (const item of items) {
      if ((FRONTS as readonly string[]).includes(item.value)) to.push(item.value);
      else check.fail(item.line, `${at}: reach.to "${item.value}" must be one of: ${FRONTS.join(', ')}`);
    }
  }
  const alias = readReachName(fields.get('alias'), `${at}: reach.alias`, REACH_ALIAS, check);
  const route = readReachName(fields.get('route'), `${at}: reach.route`, REACH_ROUTE, check);
  const keyId = readReachName(fields.get('key_id'), `${at}: reach.key_id`, REACH_ROUTE, check);
  const guardDir = readReachGuardDir(fields.get('guard_dir'), at, check);
  return {
    to,
    ...(alias !== undefined ? { alias } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(keyId !== undefined ? { keyId } : {}),
    ...(guardDir !== undefined ? { guardDir } : {}),
  };
}

function readReachName(entry: YamlEntry | undefined, name: string, rule: RegExp, check: Check): string | undefined {
  const value = check.text(entry, name);
  if (value === undefined || !entry) return undefined;
  if (!rule.test(value)) {
    check.fail(entry.value.line, `${name} "${value}" takes letters, digits, ".", "_" and "-" (a letter or digit first, 64 at most)`);
    return undefined;
  }
  return value;
}

function readReachGuardDir(entry: YamlEntry | undefined, at: string, check: Check): string | undefined {
  const value = check.text(entry, `${at}: reach.guard_dir`);
  if (value === undefined || !entry) return undefined;
  if (!isAbsolute(value)) {
    check.fail(entry.value.line, `${at}: reach.guard_dir must be an absolute path`);
    return undefined;
  }
  return value;
}

/** The projection's rules on the built seats: every granted seat's alias must satisfy the
 *  readers' rule — the defaults can outgrow it only here (a long name, a key_id of `seat-<alias>-1`
 *  past 64 characters) — and two seats must not land on one alias, the readers' duplicate rule.
 *  The projection holds at most REACH_MAX_SEATS seats. */
function reportReach(seats: DraftSeat[], check: Check): void {
  const seen = new Map<string, DraftSeat>();
  let granted = 0;
  for (const seat of seats) {
    const reach = seat.reach;
    if (!reach) continue;
    granted += 1;
    if (granted > REACH_MAX_SEATS) {
      check.fail(seat.line, `reach: the projection holds at most ${REACH_MAX_SEATS} seats — this seat is number ${granted}`);
      continue;
    }
    const alias = (reach.alias ?? seat.name).toLowerCase();
    if (!REACH_ALIAS.test(alias)) {
      check.fail(seat.line, `seat "${seat.name}": the reach alias "${alias}" takes letters, digits, ".", "_" and "-" (a letter or digit first, 64 at most)`);
    }
    if (reach.keyId === undefined && `seat-${alias}-1`.length > 64) {
      check.fail(seat.line, `seat "${seat.name}": the default reach key_id "seat-${alias}-1" is longer than 64; name a shorter alias or a key_id`);
    }
    const first = seen.get(alias);
    if (first === undefined) seen.set(alias, seat);
    else {
      check.fail(seat.line, `two seats reach the same alias "${alias}" (the other is on line ${first.line}${first.count > 1 || seat.count > 1 ? ', after count is expanded' : ''})`);
    }
  }
}
