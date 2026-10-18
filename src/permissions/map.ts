// The command-to-capability map: the decision record's table as code — one row per command,
// each saying what admits a caller before any caller is read, and the words a refusal repeats
// (decided-grants-minimum-2026-10-17, point (f); the Kernel's table, §9). The map is closed on
// purpose: 0.5.0 gates no command the table does not name, so a word with no row here is
// refused by the resolver (src/permissions/resolve.ts) rather than judged, and the code
// invents no capability. The vocabulary's own half — the eight grantable words — is imported
// from grants.ts, the one source both sides share: a grant carries only the names in that
// list, and the map's last rows are those same names, as commands. The four administrative
// names a team grant never carries (`grant`, `create`, `agree`, `leads`, grants.ts's
// TEAM_GRANT_FORBIDDEN) are a different namespace: they are never capability words, and
// `create` — named in the record's init row "where it exists" — is today no command, so the
// map holds no row for it.
import { GRANT_CAPABILITIES } from './grants.ts';

/** The grantable capabilities, as the map's vocabulary: the eight words a grant may carry, and
 *  the only names a grant may use. */
export type Capability = (typeof GRANT_CAPABILITIES)[number];

/** Whether a word is one of the eight. */
export function isCapability(word: string): word is Capability {
  return (GRANT_CAPABILITIES as readonly string[]).includes(word);
}

/** What admits a caller to one command, before any caller is read, and the words a refusal
 *  repeats. The gate is what the record's table says under "authorised by (0.5.0)". The
 *  `admission` and `pane-authority` rows name the gate that owns their commands: this map
 *  admits no one to either, and the resolver refuses them with the owner named. */
export type Gate =
  | { kind: 'owner-only'; why: string }
  | { kind: 'owner-or-leads'; why: string }
  | { kind: 'owner-or-own-team'; why: string }
  | { kind: 'seat-record'; why: string }
  | { kind: 'capability'; why: string }
  | { kind: 'admission'; why: string }
  | { kind: 'pane-authority'; why: string };

/** The nine read surfaces the record names; each admits any seat with a registry record. Two
 *  of them — `available`, `waits` — are Runtime words the table names and no command module
 *  exists for yet; their rows stand all the same, because the map is the table. */
const READ_SURFACES = ['messages', 'feed', 'status', 'list', 'check', 'usage', 'available', 'next', 'waits'] as const;

/** The whole map: the command's own word (the CLI's, src/commands/*) to what admits it. */
export const COMMAND_GATES: Readonly<Record<string, Gate>> = buildGates();

function buildGates(): Record<string, Gate> {
  const gates: Record<string, Gate> = {
    init: {
      kind: 'owner-only',
      why: 'writing a team where none exists is the owner\'s act in 0.5.0: no create-bounds exist yet, so no agent holds `create`',
    },
    up: {
      kind: 'owner-or-leads',
      why: '`start`: it runs the hash-pinned start command, and an operation is reached only through `leads` held in a role, never through a grant',
    },
    down: {
      kind: 'owner-or-leads',
      why: '`stop`: the owner or `leads` for its own team, and the owner may always stop',
    },
    restart: {
      kind: 'owner-or-leads',
      why: 'the `start` row for a seat: as `start`',
    },
    reload: {
      kind: 'owner-or-leads',
      why: 'the `start` row for a running seat, as `restart`: closing and relaunching one seat is the same act',
    },
    add: {
      kind: 'owner-only',
      why: 'adding a seat is the owner\'s in 0.5.0, where no `agree` or `grant` holders stand',
    },
    remove: {
      kind: 'owner-or-leads',
      why: 'removing a seat: the owner or `leads`; a seat holding `grant`, `agree` or `leads` stands only by the owner',
    },
    rename: {
      kind: 'owner-or-leads',
      why: 'renaming a seat: the owner or `leads` for its own team',
    },
    register: {
      kind: 'owner-or-own-team',
      why: 'a registry record is a report and confers no right: the owner, or the seat\'s own team',
    },
    grant: {
      kind: 'owner-only',
      why: 'granting is the approval, and the owner grants alone in 0.5.0',
    },
    revoke: {
      kind: 'owner-only',
      why: 'removing a standing grant is the owner\'s edit, and the revocation channel of 0.5.0 is the owner at a terminal',
    },
    delegate: {
      kind: 'owner-only',
      why: 'a standing grant with a command list, written against this map: the owner\'s',
    },
    send: {
      kind: 'admission',
      why: 'admission is chain position and the pair\'s setting, never a role\'s name: it is decided by the send admission, and this map admits no one to it',
    },
    answer: {
      kind: 'pane-authority',
      why: 'a key into another agent\'s pane belongs to the pane\'s lead, a seat above it, or the owner\'s word for that case; trust, login and security prompts to the owner\'s alone — pane authority is its own gate, and this map admits no one to it',
    },
  };
  for (const word of READ_SURFACES) {
    gates[word] = {
      kind: 'seat-record',
      why: `a read surface of the Runtime and the modules: any seat with a registry record, and the \`read\` scope is not enforced in 0.5.0`,
    };
  }
  for (const capability of GRANT_CAPABILITIES) {
    gates[capability] = {
      kind: 'capability',
      why: 'the Kernel\'s operational capability, held by the seat it names, within its scope and the constraints of §5; 0.5.0 gates none of them',
    };
  }
  return gates;
}
