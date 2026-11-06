// First-run skips for a launcher kind. A skip is a flag, setting, or launch shape the
// vendor's own notes in this repo already document. A dialog key is not a skip: the
// first minute never sends one. Where no skip is documented, the seat is waiting and
// the scene fails for that class.

export type FirstRunClass = 'survey' | 'telemetry' | 'tips' | 'feature-settings';

export type FirstRunVerdict =
  | { state: 'skipped'; class: FirstRunClass; mechanism: string }
  | { state: 'waiting'; class: FirstRunClass; why: string };

/** The classes every kind is asked for. Feature settings is the Codex dialog this
 *  repo documents; the other three are the survey, telemetry, and tips prompts. */
export const FIRST_RUN_CLASSES: readonly FirstRunClass[] = ['survey', 'telemetry', 'tips', 'feature-settings'];

/** Codex's documented own-server launch. The profile's feature pin exists so seats
 *  that share one background server do not meet "incompatible feature settings".
 *  This minute does not attach to that shared server: the seat starts its own. */
const CODEX_OWN_SERVER = {
  from: '0.157.0',
  to: '0.161.0',
  mechanism: "the seat's own app-server (--listen), not a shared server (--remote)",
} as const;

const NO_SKIP = 'this version documents no skip, and no key is sent';

function partsOf(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function inRange(version: string, from: string, to: string): boolean {
  const seen = partsOf(version);
  const low = partsOf(from);
  const high = partsOf(to);
  if (seen === null || low === null || high === null) return false;
  const compare = (left: [number, number, number], right: [number, number, number]): number => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
    }
    return 0;
  };
  return compare(seen, low) >= 0 && compare(seen, high) <= 0;
}

/** The argv a Codex seat starts in this minute. No `--remote`, so it cannot attach
 *  to a shared app-server. */
export function codexOwnServerArgv(listen: string): string[] {
  return ['codex', 'app-server', '--listen', listen];
}

function featureSettings(kind: string, version: string | null, argv: readonly string[]): FirstRunVerdict {
  if (kind !== 'codex') {
    return { state: 'waiting', class: 'feature-settings', why: NO_SKIP };
  }
  if (version === null || !inRange(version, CODEX_OWN_SERVER.from, CODEX_OWN_SERVER.to)) {
    return {
      state: 'waiting',
      class: 'feature-settings',
      why: `the seen version is outside the documented skip ${CODEX_OWN_SERVER.from}–${CODEX_OWN_SERVER.to}`,
    };
  }
  if (argv.includes('--remote')) {
    return {
      state: 'waiting',
      class: 'feature-settings',
      why: 'the launch attaches to a shared server; this minute starts the seat\'s own',
    };
  }
  const listens = argv.includes('app-server') && argv.includes('--listen');
  if (!listens) {
    return {
      state: 'waiting',
      class: 'feature-settings',
      why: 'the launch does not start the seat\'s own app-server',
    };
  }
  return { state: 'skipped', class: 'feature-settings', mechanism: CODEX_OWN_SERVER.mechanism };
}

/** One verdict per class. `argv` is the launch that would run; Codex's own-server
 *  argv is the documented feature-settings skip. Nothing in the verdicts is a key. */
export function firstRunVerdicts(
  kind: string,
  version: string | null,
  argv: readonly string[] = [],
): FirstRunVerdict[] {
  return FIRST_RUN_CLASSES.map((cls) => {
    if (cls === 'feature-settings') return featureSettings(kind, version, argv);
    return { state: 'waiting', class: cls, why: NO_SKIP };
  });
}

/** The line doctor prints for one verdict. A waiting seat is a miss. */
export function firstRunLine(kind: string, verdict: FirstRunVerdict): string {
  if (verdict.state === 'skipped') {
    return `${kind}: first-run ${verdict.class} skipped (${verdict.mechanism})`;
  }
  return `${kind}: waiting, first-run ${verdict.class}; ${verdict.why}`;
}
