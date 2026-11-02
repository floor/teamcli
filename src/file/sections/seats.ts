import { isAbsolute } from 'node:path';
import { CLIS } from '../../clis.ts';
import type { CrossSessionInbound } from '../../launch/declaration.ts';
import { shippedEfforts } from '../../profiles/efforts.ts';
import { displayEffort, profileFor } from '../../profiles/profile.ts';
import { FRONTS, REACH_ALIAS, REACH_MAX_SEATS, REACH_ROUTE } from '../../reach/rules.ts';
import { DELIVERY_LEGS, isLivenessSeconds, LIVENESS_KEYS, SENDER_NAME_MODES, type LivenessThresholds } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import { insideProject, insideTrust, normalize } from '../paths.ts';
import { hasVersionToken } from '../signature.ts';
import { seatNumberOf } from '../../seat-names.ts';
import type { Check } from '../check.ts';
import { WEBHOOK_BODY_SHAPES, type Mode, type Seat, type SeatReach, type SeatWebhook } from '../types.ts';
import type { LeadMark, Section } from './section.ts';
import { valueOf } from './section.ts';
import type { Budgeted } from './budgets.ts';
import { readDeliveryOrder } from './delivery_order.ts';
import { readSenderName } from './sender_name.ts';
import { MODES } from './workspace.ts';

/** The words a seat's `inbound` key may name: the same three the receiving CLI accepts. */
const INBOUND_WORDS: readonly CrossSessionInbound[] = ['accept', 'hold', 'refuse'];

export type DraftSeat = Omit<Seat, 'mode'> & { mode?: Mode };

/** The team file's own seat-name rule: a letter or digit first, then letters, digits, `.`, `_`
 *  and `-`. Everything that builds a path out of a seat name holds itself to the same rule —
 *  there is no second, looser one. */
export const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The send grammar's team-lead address: `lead@<team>` names the seat its file marks `leads`,
 *  so no new seat or nickname takes the name (src/send/resolve.ts). A seat already named `lead`
 *  keeps loading — the address never means it — and `team check` notes the name. */
export const LEAD_NAME = 'lead';

/** The daemon's own sender word: a reminder's record and history line read `from: daemon`, with
 *  no registry id, so no new seat or nickname takes the name — a seat of that name would be
 *  indistinguishable from the daemon in every record it wrote. A seat already named `daemon`
 *  keeps loading, like a legacy `lead`. */
export const DAEMON_NAME = 'daemon';

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
          $comment: 'the legs a send to this seat may walk, in order; it drops or reorders the order in force and may add only native, the sender\'s own frame',
        },
        sender_name: {
          enum: [...SENDER_NAME_MODES],
          $comment: 'how a sender reads in this seat\'s headlines: auto, nickname, seat or seat@team; presentation only, and the registry id stays in every record',
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
        watch_wake: {
          enum: ['on', 'off'],
          $comment: 'the watch\'s typed retry for this seat: on exactly where its CLI profile declares typed_wake unless the seat writes off, which keeps the drop-file wake',
        },
        public_only: { type: 'boolean', $comment: 'the seat\'s briefs go to a service outside this machine: the team\'s rules are never prepended, and a send reads the body against the machine\'s private lists and falls through on a match; a hosted CLI\'s profile is public-only on its own, and a seat can only add the guard' },
        inbound: {
          enum: [...INBOUND_WORDS],
          $comment: 'the seat accepts cross-session socket frames: accept authorizes the socket leg for any launch; hold and refuse never dial it; with no word, a seat TeamCLI launched is authorized by its launch\'s crossSessionInbound accept, and any other launch still needs accept here',
        },
        webhook: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url_file: { type: 'string', minLength: 1, $comment: 'absolute; the file whose contents are the routine\'s URL, read at POST time; the URL itself is never written here, printed or logged' },
            secret_file: { type: 'string', minLength: 1, $comment: 'absolute; the file whose contents authenticate the POST; it must be owned by the running user and readable by them alone (0600), and neither the path\'s value nor its contents are ever printed or logged' },
            header: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[!#$%&\'*+\\-.^_`|~0-9A-Za-z]+$', $comment: 'an HTTP field name; the secret file\'s line is sent as this header\'s value verbatim, with no scheme word added; absent, the adapter sends Authorization: Bearer <secret>' },
            body: { enum: [...WEBHOOK_BODY_SHAPES], $comment: 'the body the routine reads: event is the bus envelope {v, event}; inbox is the seat-inbox record shape, flattened from the signed message the arrival names; absent, event' },
            timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, $comment: 'how long one POST waits for the routine\'s answer, in milliseconds; absent, 5000; an answer after the bound is not read and is never retried, so the routine is not asked twice' },
          },
          required: ['url_file', 'secret_file'],
          $comment: 'the seat\'s webhook delivery adapter: every accepted signed message for the seat is POSTed to the routine, a 2xx answer is delivered, and the drop file stays as the backup; the two values are named by path, never stored here',
        },
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
      'parked', 'stopped', 'count', 'leads', 'assistant', 'human', 'watch_wake', 'public_only', 'inbound', 'webhook', 'reach', 'delivery_order', 'sender_name', 'liveness',
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
    if (nickname === DAEMON_NAME) {
      check.fail(nicknameEntry?.value.line ?? line, `${at}: "daemon" is reserved: the machine daemon's reminders send under that name, so no nickname takes it`);
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
    // The seat's own word on the watch's typed wake retry. A field of the built seat like
    // `human`, omitted when the file writes none — every file that writes none keeps the digest
    // it had, and a written word is part of the digest the owner approves. `on` needs a profile
    // that declares a typed wake: there is no other wake for the watch to type, so the word
    // would be a setting that could never run.
    const watchWakeField = fields.get('watch_wake');
    const watchWakeWord = check.oneOf(fields.get('watch_wake'), `${at}: watch_wake`, ['on', 'off']);
    let watchWake = watchWakeWord === undefined ? undefined : watchWakeWord === 'on';
    if (watchWake === true && (cli === undefined || profileFor(cli)?.typedWake == null)) {
      check.fail(watchWakeField?.value.line ?? line, `${at}: watch_wake "on" needs a CLI profile that declares typed_wake, and "${String(cli)}" declares none`);
      watchWake = undefined;
    }
    // The seat's briefs go to a service outside this machine. A field of the built seat like
    // `human`, omitted when the file marks none — every file that marks no seat keeps the digest
    // it had. A written `false` reads as absent, so a team file can only add the guard a hosted
    // CLI's profile already declares, never take it away.
    const publicOnly = check.flag(fields.get('public_only'), `${at}: public_only`);
    // The seat's own word on cross-session socket frames. A field of the built seat like
    // `human`, omitted when the file writes none — every file that writes none keeps the
    // digest it had, and a written word is part of the digest the owner approves.
    const inbound = check.oneOf<CrossSessionInbound>(fields.get('inbound'), `${at}: inbound`, [...INBOUND_WORDS]);
    // The seat's webhook adapter, when the file writes one. A field of the built seat like
    // `inbound`, omitted when the file writes none — every file that writes none keeps the
    // digest it had, and a written one is part of the digest the owner approves.
    const webhook = readWebhook(fields.get('webhook'), at, check);
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
    // The seat's own word on how a sender reads in its headlines, when the file writes one. A
    // field of the built seat like `effort`, so it is part of the seat's digest and omitted when
    // the file omits the key — every file that writes none keeps the digest it had.
    const senderName = readSenderName(fields.get('sender_name'), `${at}: sender_name`, check);
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
        // Omitted when the file writes no sender-name word, for the same reason.
        ...(senderName ? { senderName } : {}),
        // Omitted when the file writes no liveness word, for the same reason.
        ...(liveness ? { liveness } : {}),
        // Omitted when the file marks no assistant, so every file that writes none keeps its digest.
        ...(assistant && count <= 1 ? { assistant: true as const } : {}),
        // Omitted when the file marks no human, for the same reason.
        ...(human ? { human: true as const } : {}),
        // Omitted when the file writes no watch_wake word, for the same reason.
        ...(watchWake !== undefined ? { watchWake } : {}),
        // Omitted when the file marks no public-only seat, for the same reason.
        ...(publicOnly ? { publicOnly: true as const } : {}),
        // Omitted when the file writes no inbound word, for the same reason.
        ...(inbound ? { inbound } : {}),
        // Omitted when the file configures no webhook adapter, for the same reason.
        ...(webhook ? { webhook } : {}),
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

/**
 * The persona a written label names: the text before its middle dot, trimmed — the name people
 * call the seat by, and the name the launch gives its session. A written label with no middle dot
 * is the name whole. A seat whose label the file did not write has none: its stored label is the
 * model and version, and its workspace title its seat name and role. Display only; the record's
 * `nickname:` is the address and is kept equal to this word by every config write.
 */
export function labelPersona(seat: { label: string; labelWritten?: boolean }): string | null {
  if (seat.labelWritten !== true) return null;
  const name = (seat.label.split('·')[0] ?? '').trim();
  return name === '' ? null : name;
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

/** The seat's webhook adapter: two absolute paths, both required. The values they name are
 *  read at POST time and never enter the record. */
function readWebhook(entry: YamlEntry | undefined, at: string, check: Check): SeatWebhook | undefined {
  if (!entry) return undefined;
  const node = entry.value;
  if (node.kind !== 'map') {
    if (!(node.kind === 'scalar' && node.value === null)) {
      check.fail(node.line, `${at}: webhook must be a map of url_file and secret_file`);
      return undefined;
    }
    check.fail(node.line, `${at}: webhook.url_file is required`);
    check.fail(node.line, `${at}: webhook.secret_file is required`);
    return undefined;
  }
  const fields = check.fields(node, `${at}: webhook`, ['url_file', 'secret_file', 'header', 'body', 'timeout_ms']);
  const urlFile = readWebhookPath(check.required(fields.get('url_file'), `${at}: webhook.url_file`, node.line), `${at}: webhook.url_file`, fields.get('url_file'), check);
  const secretFile = readWebhookPath(check.required(fields.get('secret_file'), `${at}: webhook.secret_file`, node.line), `${at}: webhook.secret_file`, fields.get('secret_file'), check);
  const header = readWebhookHeader(fields.get('header'), `${at}: webhook.header`, check);
  const body = check.oneOf(fields.get('body'), `${at}: webhook.body`, [...WEBHOOK_BODY_SHAPES]);
  const timeoutMs = readWebhookTimeout(fields.get('timeout_ms'), `${at}: webhook.timeout_ms`, check);
  if (urlFile === undefined || secretFile === undefined) return undefined;
  return {
    urlFile,
    secretFile,
    ...(header === undefined ? {} : { header }),
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** The delivery's answer bound, when the row names one: a whole number of milliseconds this
 *  build can honour, from one to a minute. Anything else is refused rather than clamped — a
 *  bound the row did not write would be a different routine contract than the one it asked for. */
function readWebhookTimeout(entry: YamlEntry | undefined, name: string, check: Check): number | undefined {
  if (!entry) return undefined;
  const node = entry.value;
  if (
    node.kind === 'scalar'
    && typeof node.value === 'number'
    && Number.isInteger(node.value)
    && node.value >= 1
    && node.value <= 60_000
  ) {
    return node.value;
  }
  check.fail(node.line, `${name} must be a whole number from 1 to 60000`);
  return undefined;
}

/** An HTTP field name, as the front's own webhook reader accepts one. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The header a seat names for its secret, when it names one. The adapter writes content-type
 *  itself; a row naming it would replace the JSON one with the secret. */
function readWebhookHeader(entry: YamlEntry | undefined, name: string, check: Check): string | undefined {
  const value = check.text(entry, name);
  if (value === undefined) return undefined;
  if (value.length > 64 || !HEADER_NAME.test(value)) {
    check.fail(entry?.value.line ?? 0, `${name} must be an HTTP field name`);
    return undefined;
  }
  if (value.toLowerCase() === 'content-type') {
    check.fail(entry?.value.line ?? 0, `${name} cannot be content-type: the adapter writes that header itself`);
    return undefined;
  }
  return value;
}

function readWebhookPath(
  value: string | undefined, name: string, entry: YamlEntry | undefined, check: Check,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    check.fail(entry?.value.line ?? 0, `${name} must be an absolute path`);
    return undefined;
  }
  return value;
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
  if (nickname === DAEMON_NAME) {
    return { line: 0, message: '"daemon" is reserved: the machine daemon\'s reminders send under that name, so no new name or nickname takes it' };
  }
  for (const other of seats) {
    if (other.name === own) continue;
    // A roster seat the file no longer declares carries no line: its word still addresses it,
    // and the refusal says where the seat is rather than printing a line no file holds.
    const where = other.line > 0 ? `(line ${other.line})` : '(no longer declared in the team file)';
    if (other.nickname === nickname) {
      return { line: other.line, message: `the nickname "${nickname}" is also on seat "${other.name}" ${where}` };
    }
    if (other.name === nickname) {
      return { line: other.line, message: `the nickname "${nickname}" is the name of another seat ${where}` };
    }
  }
  return null;
}

/**
 * The name each seat goes by, by seat name: the persona its written label names when the
 * `nickname:` field could hold it, and the record's own `nickname:` field otherwise — null when
 * the seat carries no name beyond its seat name. A word the field could not hold is display
 * alone: a space or an accent in a label (a name is letters, digits, ".", "_" and "-"), the
 * reserved `lead`, and any word another seat's name or `nickname:` already carries stay a
 * workspace title, never a roster nickname. Every reader of the name — a roster line
 * (src/registry/sync.ts), each launch name (src/send/names.ts) and the header a message opens
 * with — reads this one answer, so a label like "Jane Doe · implementer" cannot break the address
 * that already works, and the record and the label can never name two people.
 *
 * Seats are read in file order and one word never names two of them: every seat's name and field
 * nickname is held from the start, so a label never takes a word the field has already given a
 * seat, and of two labels naming one word the earlier keeps it and the later keeps its field. A
 * label that names the seat itself adds no second name — the seat's name is already its own and
 * unique in the team — so it stands even for the legacy seat named `lead`.
 */
export function seatNicknames(
  seats: ReadonlyArray<{ name: string; nickname?: string; label: string; labelWritten?: boolean }>,
): Map<string, string | null> {
  const held = new Set<string>();
  for (const seat of seats) {
    held.add(seat.name);
    if (seat.nickname !== undefined) held.add(seat.nickname);
  }
  const out = new Map<string, string | null>();
  const projected = new Set<string>();
  for (const seat of seats) {
    const persona = labelPersona(seat);
    // Names the field has given another seat: a label's word never takes one.
    const elsewhere = new Set(held);
    elsewhere.delete(seat.name);
    if (seat.nickname !== undefined) elsewhere.delete(seat.nickname);
    const ownName = persona !== null && persona === seat.name;
    const usable = persona !== null && SEAT_NAME.test(persona)
      && (ownName || (persona !== LEAD_NAME && !elsewhere.has(persona) && !projected.has(persona)));
    const name = usable ? persona : seat.nickname ?? null;
    out.set(seat.name, name);
    if (name !== null) projected.add(name);
  }
  return out;
}

/** One seat's name, read by the same rule as `seatNicknames`: the label's persona when the field
 *  could hold it, else the record's own `nickname:` field. */
export function seatNickname(
  seats: ReadonlyArray<{ name: string; nickname?: string; label: string; labelWritten?: boolean }>,
  seat: { name: string; nickname?: string; label: string; labelWritten?: boolean },
): string | null {
  const name = seatNicknames(seats).get(seat.name);
  return name === undefined ? seat.nickname ?? null : name;
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
