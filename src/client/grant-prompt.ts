// The short French line the owner reads at signing: the macOS Touch ID prompt (which truncates
// long reasons) and the owner page's grant card. The full permission list stays in the terminal
// and inbox text (`pendingSummary(...).text`); this line only names the team, the commands that
// matter (up/down explicitly), the bundle, the signer and the expiry in the owner's local time.

import { clientDisplayName } from './bundles.ts';

/** The prompt budget: macOS shows about this much of a reason before it cuts it. */
export const GRANT_PROMPT_MAX = 210;

const SEAT_OPS = new Set(['add', 'remove', 'rename', 'swap', 'restart', 'reload']);

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** `26 janv. 2027 à 08:22 (heure de Paris)`, in the machine's own zone (or `timeZone`). */
export function frenchExpiry(iso: string | null, timeZone?: string): string {
  if (iso === null) return "sans date de fin (jusqu'à révocation)";
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const city = zone === 'UTC' || zone === 'Etc/UTC' ? 'UTC' : zone.includes('/') ? `heure de ${zone.split('/').pop()!.replace(/_/g, ' ')}` : `heure ${zone}`;
  return `le ${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year} à ${parts.hour}:${parts.minute} (${city})`;
}

function list(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} et ${words[words.length - 1]}`;
}

export type GrantPromptInput = {
  client: string;
  team: string;
  ops: readonly string[];
  /** Seats `send` reaches; omitted or empty when the grant carries no send. */
  sendSeats?: readonly string[];
  bundle?: string | null;
  master?: boolean;
  expires: string | null;
  signer?: string | null;
};

/** The French one-liner, kept under GRANT_PROMPT_MAX by eliding the send seats first. */
export function frenchGrantPrompt(input: GrantPromptInput, timeZone?: string): string {
  const ops = new Set(input.ops);
  const doing: string[] = [];
  if (ops.has('up') && ops.has('down')) doing.push("démarrer/arrêter (up/down)");
  else if (ops.has('up')) doing.push('démarrer (up)');
  else if (ops.has('down')) doing.push('arrêter (down)');
  if ([...ops].some((op) => SEAT_OPS.has(op))) doing.push('gérer les sièges');
  const seats = input.sendSeats ?? [];
  const sendAt = ops.has('send') ? doing.length : -1;
  if (ops.has('send')) doing.push(`envoyer à ${seats.length > 0 ? list(seats) : 'aucun siège'}`);
  const covered = ['up', 'down', 'send', ...SEAT_OPS];
  const rest = [...ops].filter((op) => !covered.includes(op)).length;
  if (rest > 0 && doing.length === 0) doing.push(`${rest} droit${rest > 1 ? 's' : ''} de lecture`);
  const kind = input.master === true ? ' — grant MAÎTRE' : input.bundle ? ` — bundle ${input.bundle.charAt(0).toUpperCase()}${input.bundle.slice(1)}` : '';
  const tail = `${input.signer ? ` Signataire : ${input.signer}.` : ''} Expire ${frenchExpiry(input.expires, timeZone)}.`;
  const name = clientDisplayName(input.client);
  const build = (withId: boolean, parts: string[]) => `Autoriser ${name}${withId ? ` (client ${input.client})` : ''} sur l'équipe ${input.team}${kind}${parts.length > 0 ? ` : ${parts.join(', ')}` : ''}.${tail}`;
  const counted = [...doing];
  if (sendAt >= 0) counted[sendAt] = `envoyer à ${seats.length} siège${seats.length > 1 ? 's' : ''}`;
  // Shortest last: the client id, then the send seats by count, then the actions themselves.
  const tries = [build(true, doing), build(false, doing), build(false, counted), build(false, [])];
  const text = tries.find((t) => t.length <= GRANT_PROMPT_MAX) ?? tries[tries.length - 1]!;
  return text;
}
