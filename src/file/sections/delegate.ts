import type { YamlEntry, YamlNode } from '../../yaml.ts';
import { DELEGATE_COMMANDS, type Delegate, type Delegates, type DelegateCommand } from '../../delegate-types.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';

/** The most panes the `delegates` section may name. */
export const DELEGATES_MAX = 8;

const NAMES = DELEGATE_COMMANDS.join(', ');

/**
 * The panes outside the team's session that may run named operational commands. Omitted it is
 * `null` and nothing is delegated; each pane ID is herdr's, so it survives a rename and a restart
 * names the same place holding a new process.
 */
export const delegates: Section = {
  name: 'delegates',
  owner: true,
  after: ['session', 'seats'],
  validate(entry, ctx) {
    return readDelegates(entry, ctx.check, valueOf<string>(ctx, 'session'));
  },
  schema: {
    type: 'array',
    minItems: 1,
    maxItems: DELEGATES_MAX,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['pane', 'commands'],
      properties: {
        pane: {
          type: 'string',
          pattern: '^[^\\s/]+/[^\\s/]+$',
          $comment: '<herdr session>/<pane id>, such as main/w1:p1; the session must not be the team\'s own',
        },
        commands: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { enum: DELEGATE_COMMANDS },
        },
      },
    },
    $comment: 'the panes that may run these of up, down, add, remove and approve; swap admits remove --keep and add of a lead seat. Omitted means no delegate',
  },
};

function readDelegates(entry: YamlEntry | undefined, check: Check, session: string): Delegates {
  if (!entry) return null;
  const node = entry.value;
  if (node.kind !== 'seq') {
    check.fail(node.line, 'delegates must be a list of panes and their commands');
    return null;
  }
  if (node.items.length === 0) {
    check.fail(node.line, 'delegates must name at least one pane');
    return null;
  }
  if (node.items.length > DELEGATES_MAX) {
    check.fail(node.line, `delegates must name at most ${DELEGATES_MAX} panes`);
  }
  const entries: Delegate[] = [];
  const seen = new Map<string, number>();
  for (const item of node.items) {
    const one = readEntry(item, check, session);
    if (!one) continue;
    const first = seen.get(one.pane);
    if (first !== undefined) {
      check.fail(item.line, `two delegates name the pane "${one.pane}" (the other is on line ${first})`);
      continue;
    }
    seen.set(one.pane, item.line);
    entries.push(one);
  }
  return entries.length ? entries : null;
}

function readEntry(item: YamlNode, check: Check, session: string): Delegate | null {
  if (item.kind !== 'map') {
    check.fail(item.line, 'a delegate must be a map with pane and commands');
    return null;
  }
  // Unknown keys are refused here: `seat`, `trust`, `answer` and every other name is not one.
  const fields = check.fields(item, 'a delegate', ['pane', 'commands']);
  if (item.entries.length === 0) {
    check.fail(item.line, 'a delegate must contain pane and commands');
    return null;
  }
  const pane = readPane(fields.get('pane'), check, item.line, session);
  const commands = readCommands(fields.get('commands'), check, item.line);
  if (pane === undefined || commands === null) return null;
  return { pane, commands };
}

// The pane is herdr's `pane_id`, not an agent name or a workspace label, because the ID is what
// survives a restart. On herdr 0.7.1, in a scratch session made and deleted for the check:
// workspaces w1, w2 and w3 held panes w1:p1, w2:p1 and w3:p1; closing w2 left the next workspace
// w4, not w2; after `herdr session stop` and a new server the same w1, w3 and w4 came back under
// those IDs, the next workspace was w5, and w1:p1's shell PID had changed (83767 to 84315). The
// ID therefore names the same place holding a fresh process — a closed pane made again has a new
// ID, so delegation is off until the owner approves that new ID.

/** `<herdr session>/<pane id>`: one `/`, two non-empty components, no whitespace, case kept. */
function readPane(entry: YamlEntry | undefined, check: Check, line: number, session: string): string | undefined {
  const pane = check.required(entry, 'a delegate: pane', line);
  if (pane === undefined) return undefined;
  const at = entry?.line ?? line;
  const parts = pane.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    check.fail(at, `a delegate: pane must be <herdr session>/<pane id>, such as main/w1:p1: "${pane}"`);
    return undefined;
  }
  if (/\s/.test(pane)) {
    check.fail(at, `a delegate: pane must not contain whitespace: "${pane}"`);
    return undefined;
  }
  if (parts[0] === session) {
    check.fail(at, `a delegate: pane names the team's own session "${session}": a delegate must be a pane outside it`);
    return undefined;
  }
  return pane;
}

/**
 * A non-empty ordered list of distinct lower-case `up`, `down`, `add`, `remove`, `approve` and
 * `swap` (the replacement of a lead seat's agent: `remove <lead> --keep`, then `add <lead>`).
 * `approve` is grantable like the rest: a delegated approval of a change to any owner section
 * but `rules` is refused by the gate's allowlist, never here (src/delegate.ts).
 */
function readCommands(entry: YamlEntry | undefined, check: Check, line: number): DelegateCommand[] | null {
  if (!entry) {
    check.fail(line, 'a delegate: commands is required');
    return null;
  }
  const node = entry.value;
  const empty = node.kind === 'scalar' && node.value === null;
  if (node.kind !== 'seq' && !empty) {
    check.fail(node.line, `a delegate: commands must be a list of ${NAMES}`);
    return null;
  }
  const items = check.list(entry, 'a delegate: commands');
  if (items.length === 0) {
    check.fail(node.line, `a delegate: commands must name at least one of: ${NAMES}`);
    return null;
  }
  const commands: DelegateCommand[] = [];
  for (const item of items) {
    if (!(DELEGATE_COMMANDS as readonly string[]).includes(item.value)) {
      check.fail(item.line, `a delegate: commands must name ${NAMES}: "${item.value}" is not one`);
      continue;
    }
    if (commands.includes(item.value as DelegateCommand)) {
      check.fail(item.line, `a delegate: commands names "${item.value}" twice`);
      continue;
    }
    commands.push(item.value as DelegateCommand);
  }
  return commands.length ? commands : null;
}
