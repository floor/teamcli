// A CLI that keeps one background server behind every seat refuses a second front end whose
// feature settings differ ("background server has incompatible feature settings"), and the seat
// that answers its own dialog with "run without daemon" loses the route its drops arrive on.
// The profile's `features` list is the one set every launch pins, appended after the seat's own
// words so the CLI's own last-wins config rule makes them the effective values. This module reads
// a launch line back for those words, so `team doctor` and `team check` can name a running seat
// whose RECORDED line (the base recipe in team's own state, never a process's command line) does
// not carry the pin. Both the launch placement and this reader read the CLI's own decoded words:
// a pin inside a quoted script that runs the CLI is one the CLI reads, and a pin after that
// script's closing quote is not. A line neither can decode is read as carrying no pin and says
// so, rather than as carrying one no CLI was shown to receive.
import { decodedWordsOf } from './cli-scope.ts';

/** The words a launch line carries for one pinned feature set: `-c features.<name>=<value>`,
 *  one pair per entry. The profile refuses any pair that is not `name=true|false`, so these
 *  words are always bare shell words and need no quoting. */
export function pinnedWords(features: readonly string[]): string[] {
  return features.flatMap((pair) => ['-c', `features.${pair}`]);
}

/** The CLI's decoded words for a recorded line: the caller's own reading when it has one (the
 *  launch scope, `cliWordList`), else the same reader applied to the line on its own. Null when
 *  the line cannot be decoded — a line no shell scope proves carries no readable pin. */
function decodedFor(line: string, words: readonly string[] | null | undefined): readonly string[] | null {
  return words === undefined ? decodedWordsOf(line) : words;
}

/** One feature name's effective value on a launch line, read the way the CLI reads its own
 *  words. Only `-c`/`--config` pairs are read — the spelling the profile pins and the one the
 *  seat's own config words already use — with the last pair for a name winning. A bare `--`
 *  ends option parsing, as it does for the CLI: a word after it is positional, and a
 *  config-shaped prompt word names no feature. `words` is the line already decoded by the
 *  launch scope; when it is omitted the line is decoded here, and an unreadable line names no
 *  feature at all. */
export function featureSettings(line: string, words?: readonly string[] | null): Map<string, boolean> {
  const decoded = decodedFor(line, words);
  const settings = new Map<string, boolean>();
  if (decoded === null) return settings;
  for (let i = 0; i < decoded.length; i++) {
    const word = decoded[i]!;
    if (word === '--') break;
    const inline = /^--config=(.*)$/.exec(word);
    const value = word === '-c' || word === '--config' ? decoded[i + 1] : inline?.[1];
    if (value === undefined) continue;
    if (word === '-c' || word === '--config') i++;
    const pair = /^features\.([A-Za-z0-9_]+)=(true|false)$/.exec(value.trim());
    if (pair !== null) settings.set(pair[1]!, pair[2] === 'true');
  }
  return settings;
}

/** The profile's pinned pairs a recorded launch line does not set: absent from it, or set to the
 *  other value. Empty when every pin is effectively on the line. A feature name the line sets on
 *  its own, outside this list, is the file's own word and not this reading's to refuse. A line
 *  this reader cannot decode carries no proven pin, so every required pair is reported: the
 *  report says the line cannot be read instead of guessing it carries what was written after a
 *  script the CLI never received. */
export function featureGaps(line: string, required: readonly string[], words?: readonly string[] | null): string[] {
  const decoded = decodedFor(line, words);
  if (decoded === null) return [...required];
  const settings = featureSettings(line, decoded);
  const gaps: string[] = [];
  for (const pair of required) {
    const at = pair.lastIndexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    if (settings.get(name) !== (pair.slice(at + 1) === 'true')) gaps.push(pair);
  }
  return gaps;
}

/** The sentence naming a seat whose recorded line misses its profile's pins, or null when the
 *  line carries them all. `undefined` is a seat whose record holds no launch line at all: that
 *  is unknown, not wrong, and said so — the record itself cannot be repaired, only the relaunch
 *  that writes one. A line that cannot be decoded says so in its own words: it is not reported
 *  as carrying pins the CLI was never shown to read. The profile list is empty for a CLI that
 *  pins no features: nothing is said. */
export function featureMismatch(line: string | undefined, features: readonly string[], words?: readonly string[] | null): string | null {
  if (features.length === 0) return null;
  // Named as the launch line spells them: the profile list holds `name=value`, the word on the
  // line is `features.name=value`, and this sentence is about the line.
  const said = (pairs: readonly string[]): string => pairs.map((pair) => `features.${pair}`).join(', ');
  if (line === undefined) return `its recorded launch line is unknown; the profile pins ${said(features)} on every launch`;
  if (decodedFor(line, words) === null) {
    return `its recorded launch line cannot be read; the profile pins ${said(features)} on every launch`;
  }
  const gaps = featureGaps(line, features, words);
  if (gaps.length === 0) return null;
  return `its recorded launch line does not pin ${said(gaps)}; the profile pins ${said(features)} on every launch`;
}
