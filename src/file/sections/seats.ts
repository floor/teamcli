import { isAbsolute } from 'node:path';
import { CLIS } from '../../clis.ts';
import { shippedEfforts } from '../../profiles/efforts.ts';
import { displayEffort } from '../../profiles/profile.ts';
import { FRONTS, REACH_ALIAS, REACH_MAX_SEATS, REACH_ROUTE } from '../../reach/rules.ts';
import { DELIVERY_LEGS, isLivenessSeconds, LIVENESS_KEYS, type LivenessThresholds } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import { insideProject, insideTrust, normalize } from '../paths.ts';
import { hasVersionToken } from '../signature.ts';
import { seatNumberOf } from '../../seat-names.ts';
import type { Check } from '../check.ts';
import type { Mode, Seat, SeatReach } from '../types.ts';
import type { LeadMark, Section } from './section.ts';
import { valueOf } from './section.ts';
import type { Budgeted } from './budgets.ts';
import { readDeliveryOrder } from './delivery_order.ts';
import { MODES } from './workspace.ts';

export type DraftSeat = Omit<Seat, 'mode'> & { mode?: Mode };

/** The team file's own seat-name rule: a letter or digit first, then letters, digits, `.`, `_`
 *  and `-`. Everything that builds a path out of a seat name holds itself to the same rule —
 *  there is no second, looser one. */
export const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The send grammar's team-lead address: `lead@<team>` names the seat its file marks `leads`,
 *  so no new seat or nickname takes the name (src/send/resolve.ts). A seat already named `lead`
 *  keeps loading — the address never means it — and `team check` notes the name. */
export const LEAD_NAME = 'lead';

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
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', $comment: 'a seat named "lead" still loads: lead@<team> always addresses the seat holding leads, and team check notes the name' },
        nickname: {
          type: 'string',
          pattern: '^(?!lead$)[A-Za-z0-9][A-Za-z0-9._-]*$',
          $comment: 'a human name for this seat: unique in its team and never another seat\'s name, and "lead" is reserved for the team\'s lead address; a send addresses it bare in its own team, as @<nickname>, or as <nickname>@<team>, and it confers nothing — the role keeps the grants',
        },
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
        delivery_order: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { enum: DELIVERY_LEGS },
          $comment: 'the legs a send to this seat may walk, in order; it drops or reorders the order in force and never adds a leg, which the walk settles',
        },
        liveness: {
          type: 'object',
          additionalProperties: false,
          properties: {
            idle_lead_seconds: { type: 'number', exclusiveMinimum: 0, $comment: 'how long this seat may sit idle before its lead is told; tighter, never looser' },
            idle_owner_seconds: { type: 'number', exclusiveMinimum: 0, $comment: 'how long after that its owner is told, once per idle period; tighter, never looser' },
            blind_after_seconds: { type: 'number', exclusiveMinimum: 0, $comment: 'how long this seat may read unknown before it is blind; a project may open it, and this seat closes it for itself' },
          },
          $comment: 'the seat\'s own word on the liveness defaults, in seconds; it tightens a window the chain above set, and is set aside where it would loosen one',
        },
        mode: { enum: MODES },
        parked: { type: 'boolean' },
        stopped: { type: 'boolean' },
        leads: { type: 'boolean', $comment: 'the seat that leads: exactly one seat carries it' },
        assistant: { type: 'boolean', $comment: 'the entity\'s assistant: at most one seat carries it' },
        human: { type: 'boolean', $comment: 'the pane is a person\'s: a send walks the drop leg alone, every other leg skipped, and the watch types no retry or nudge there' },
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
  const assistants: { name: string; line: number }[] = [];
  for (const item of entry.value.items) {
    const fields = check.fields(item, 'a seat', [
      'role', 'name', 'nickname', 'cli', 'vendor', 'account', 'model_from', 'model', 'version', 'display', 'launch', 'cwd', 'label', 'effort', 'mode',
      'parked', 'stopped', 'count', 'leads', 'assistant', 'human', 'reach', 'delivery_order', 'liveness',
    ]);
    if (item.kind !== 'map') continue;
    const line = item.line;
    const role = check.required(fields.get('role'), 'a seat\'s role', line);
    const name = check.required(fields.get('name'), 'a seat\'s name', line);
    const at = name ? `seat "${name}"` : 'a seat';
    if (name && !SEAT_NAME.test(name)) {
      check.fail(fields.get('name')?.line ?? line, `${at}: the name takes letters, digits, ".", "_" and "-"`);
    }
    // `lead` is the send grammar's team-lead address (`lead@<team>`, src/send/resolve.ts). A seat
    // already named `lead` is legacy and keeps loading — the address still means the seat holding
    // `leads`, and `team check` notes a `lead` seat that holds them not — but no nickname may take
    // the name, and `team add` and `team rename` refuse it: the reservation binds new names only.
    // The human name for this seat. It confers nothing — the role keeps the
    // grants — and it is a field of the built seat like every other, so it is in the digest and
    // omitted when the file omits the key. The same rule as the name, because a send addresses
    // it as `<nickname>@<team>` and `@` is the address's own separator.
    const nicknameEntry = fields.get('nickname');
    let nickname = check.text(nicknameEntry, `${at}: nickname`);
    if (nickname !== undefined && !SEAT_NAME.test(nickname)) {
      check.fail(nicknameEntry?.value.line ?? line, `${at}: the nickname takes letters, digits, ".", "_" and "-"`);
      nickname = undefined;
    }
    if (nickname === LEAD_NAME) {
      check.fail(nicknameEntry?.value.line ?? line, `${at}: "lead" is reserved: lead@<team> addresses the team's lead, so no nickname takes it`);
      nickname = undefined;
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
    // The entity's assistant, unlike the lead, is a field of the built seat: there is no second
    // spelling of it to equate a marked file with, and it admits a send, so it belongs in the
    // seat's digest — granting it is a change the owner approves. At most one seat carries it,
    // and never a seat with a count: the slot names one seat, and admission reads its name.
    const assistantField = fields.get('assistant');
    const assistant = check.flag(assistantField, `${at}: assistant`);
    if (assistant && name && assistantField) assistants.push({ name, line: assistantField.value.line });
    // The pane is a person's: no leg of a send types into it, and the watch types no retry or
    // nudge there either. A field of the built seat like `assistant`, omitted when the file
    // marks none — every file that marks no seat keeps the digest it had.
    const human = check.flag(fields.get('human'), `${at}: human`);
    const count = check.whole(fields.get('count'), `${at}: count`, 1) ?? 1;
    if (assistant && count > 1) {
      check.fail(assistantField?.value.line ?? line, `\`assistant\` on "${name}" can't be a seat with count`);
    }
    // A nickname names one seat: a counted entry becomes several, and one human name cannot be
    // held by all of them — an address would have to pick one. Refused like `assistant`.
    if (nickname !== undefined && count > 1) {
      check.fail(nicknameEntry?.value.line ?? line, `\`nickname\` on "${name}" can't be a seat with count`);
    }
    const label = check.text(fields.get('label'), `${at}: label`);
    const effort = readEffort(fields.get('effort'), at, vendor, check);
    // The seat's own word on the delivery order, when the file writes one. A field of the built
    // seat like `effort`, so it is part of the seat's digest and omitted when the file omits the
    // key — every file that writes none keeps the digest it had.
    const deliveryOrder = readDeliveryOrder(fields.get('delivery_order'), `${at}: delivery_order`, check);
    // The seat's own word on the liveness defaults. A field of the built seat like `effort`, so
    // it is part of the seat's digest and omitted when the file omits the key — every file that
    // writes none keeps the digest it had.
    const liveness = readLiveness(fields.get('liveness'), at, check);
    // The written label, or the lowercase model and version, stays on the seat: `seatDigest`
    // hashes `label`, and a file the owner approved keeps its key. `labelWritten` is not hashed: it only
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
        // Omitted when the file writes no nickname, so `seatDigest` hashes the same fields as
        // before; a counted entry never carries one (it is refused above).
        ...(nickname !== undefined && count <= 1 ? { nickname } : {}),
        // Omitted when the file has no effort, so `seatDigest` hashes the same fields as before.
        ...(effort ? { effort } : {}),
        // Omitted when the file declares no order, for the same reason.
        ...(deliveryOrder ? { deliveryOrder } : {}),
        // Omitted when the file writes no liveness word, for the same reason.
        ...(liveness ? { liveness } : {}),
        // Omitted when the file marks no assistant, so every file that writes none keeps its digest.
        ...(assistant && count <= 1 ? { assistant: true as const } : {}),
        // Omitted when the file marks no human, for the same reason.
        ...(human ? { human: true as const } : {}),
        ...(modelFrom ? { modelFrom } : {}),
        ...(mode ? { mode } : {}),
        ...(reach ? { reach } : {}),
      });
    }
  }
  reportCollisions(seats, 'name', check);
  reportNumberClashes(seats, check);
  reportNicknames(seats, check);
  reportReach(seats, check);
  // Refused at the second mark's line, the one that makes it more than one — the lead's own
  // refusal, one seat over: the entity's assistant is one seat, and admission reads its name.
  if (assistants.length > 1) {
    check.fail(assistants[1]!.line, '`assistant` is on more than one seat: a team has one assistant');
  }
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

/** Line 2's display_agent: the display, a space, then the effort, or `default` when the file sets
 *  none. A CLI whose launcher takes no effort setting carries the display alone. Herdr writes the
 *  status word and ` · ` in front of this text. */
export function displayAgent(seat: { display: string; effort?: string; cli: string }): string {
  const effort = displayEffort(seat.cli, seat.effort);
  return effort === null ? seat.display : `${seat.display} ${effort}`;
}

/** A seat's `liveness:` map, checked: only the three thresholds, each a whole number of seconds,
 *  at least one — the same rule the resolver judges every liveness word by. Any other key, or a
 *  value that is not one, fails the file at the field's line, and the map declares nothing — no
 *  partial word is taken from a map that did not read. */
function readLiveness(entry: YamlEntry | undefined, at: string, check: Check): Partial<LivenessThresholds> | undefined {
  if (!entry) return undefined;
  const node = entry.value;
  if (node.kind !== 'map') {
    check.fail(node.line, `${at}: liveness must be a map of thresholds`);
    return undefined;
  }
  const out: Partial<LivenessThresholds> = {};
  let bad = false;
  for (const field of node.entries) {
    if (!(LIVENESS_KEYS as readonly string[]).includes(field.key)) {
      check.fail(field.line, `${at}: liveness has no threshold "${field.key}"; the keys are ${LIVENESS_KEYS.join(', ')}`);
      bad = true;
      continue;
    }
    const value = field.value;
    if (value.kind !== 'scalar' || typeof value.value !== 'number' || !isLivenessSeconds(value.value)) {
      check.fail(value.line, `${at}: liveness "${field.key}" must be a whole number of seconds, at least 1`);
      bad = true;
      continue;
    }
    out[field.key as keyof LivenessThresholds] = value.value;
  }
  return bad || Object.keys(out).length === 0 ? undefined : out;
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

/**
 * Two names of one role that carry one number — `builder-1` and `builder-01` — are one seat
 * written twice at two widths: the numbering points at one seat and an address would have to
 * pick. Refused at the second name's line, so the file never loads, and `add` and `register`,
 * which read the file first, refuse the same way. The exact duplicate name above is not repeated
 * here. `builder` (a name with no number) and `builder-1` are distinct seats, as they always were.
 */
function reportNumberClashes(seats: DraftSeat[], check: Check): void {
  const seen = new Map<string, { name: string; line: number }>();
  for (const seat of seats) {
    const number = seatNumberOf(seat.name);
    if (number === null) continue;
    const key = `${seat.role}\u0000${number.base}\u0000${String(number.number)}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, { name: seat.name, line: seat.line });
      continue;
    }
    if (first.name === seat.name) continue;
    check.fail(seat.line, `two seats have the same role and number: "${first.name}" on line ${first.line} and "${seat.name}" here (the number is written with and without leading zeros)`);
  }
}

/**
 * Why `nickname` cannot be written on the seat `own`, or null: another seat already carries it,
 * or it is another seat's name. Either would make one spec match two seats, and a send refuses
 * such a spec — so the collision is prevented here, where names are written (RFC 002 § 4).
 * A nickname equal to its own seat's name is not a collision: both spellings reach one seat.
 * Exported for the rename command, which writes a nickname where no file check runs.
 */
export function nicknameProblem(
  seats: ReadonlyArray<{ name: string; nickname?: string; line: number }>,
  nickname: string,
  own: string,
): { line: number; message: string } | null {
  if (nickname === LEAD_NAME) {
    return { line: 0, message: '"lead" is reserved: lead@<team> addresses the team\'s lead, so no new name or nickname takes it' };
  }
  for (const other of seats) {
    if (other.name === own) continue;
    if (other.nickname === nickname) {
      return { line: other.line, message: `the nickname "${nickname}" is also on seat "${other.name}" (line ${other.line})` };
    }
    if (other.name === nickname) {
      return { line: other.line, message: `the nickname "${nickname}" is the name of another seat (line ${other.line})` };
    }
  }
  return null;
}

/** One report per nickname: the second seat carrying it, or the seat whose human name an
 *  earlier seat's name would shadow. A nickname equal to its own seat's name is allowed. */
function reportNicknames(seats: DraftSeat[], check: Check): void {
  const seen = new Map<string, DraftSeat>();
  for (const seat of seats) {
    const nickname = seat.nickname;
    if (nickname === undefined) continue;
    const first = seen.get(nickname);
    if (first !== undefined) {
      if (first.name !== seat.name) {
        check.fail(seat.line, `seat "${seat.name}": two seats have the nickname "${nickname}" (the other is "${first.name}" on line ${first.line})`);
      }
      continue;
    }
    seen.set(nickname, seat);
    const clash = seats.find((other) => other.name !== seat.name && other.name === nickname);
    if (clash !== undefined) {
      check.fail(seat.line, `seat "${seat.name}": the nickname "${nickname}" is the name of another seat (line ${clash.line})`);
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
