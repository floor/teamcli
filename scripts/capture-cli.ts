// Refreshes the real-CLI capture corpus, one CLI version at a time. Live CLIs need local
// credentials and an interactive PTY, so this runs on a developer/operator machine inside a
// throwaway herdr session, and every screen it writes is scrubbed and registered before it is
// committed as a static `.txt` fixture.
//
//   bun scripts/capture-cli.ts --cli <cli>                    capture the automatic stages
//   bun scripts/capture-cli.ts --cli <cli> --write            ... and write them as fixtures
//   bun scripts/capture-cli.ts --cli <cli> --stage unsent --write
//   bun scripts/capture-cli.ts --cli <cli> --stage permission --prompt "..." --write
//
// Stages, in the order a full run takes them:
//   trust       the fresh-directory trust question, captured before anything is trusted
//   idle        the empty prompt after launch, in the 54x23 pane `up` creates
//   unsent      a deterministic probe typed into the composer and never sent
//   working     an active turn; needs --prompt, which is typed into the idle composer
//   question    a choice dialog; needs --prompt, dismissed with Escape after the capture
//   permission  a tool/command approval; needs --prompt, dismissed with Escape
//   exit        the pane back at its shell after the profile's exit text
//
// Without --stage, a run captures trust, idle, unsent and exit. The three attention stages
// need a prompt that provokes them on that CLI, so they are named explicitly; each runs in its
// own scratch session so a broken prompt cannot spoil the automatic stages.
//
// --write writes `test/fixtures/<cli>/<version>/<file>`, adds the entries to
// `test/fixtures/conformance.json` with `"provenance": "capture"`, generates the folder's
// README when it has none, bumps the profile's tested.to when the whole baseline set was
// captured and every screen reads as its baseline kind, and regenerates
// `contract/capture-coverage.json`. A capture that reads as a different kind is never written:
// the profile rule for that stage needs fixing first, as the design note says.
//
// A baseline kind the run did not produce is *not* papered over: the README's `## Not produced`
// section is the operator's statement about the CLI, so the script prints the kinds still owed
// and leaves the section to them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename as pathBasename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSgr } from '../src/ansi.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import {
  paneRead,
  paneShellBack,
  pressEnter,
  sendKey,
  sessionDelete,
  sessionStop,
  startServer,
  typeText,
  workspaceClose,
  workspaceCreate,
} from '../src/herdr.ts';
import { parseVersion, profileFor } from '../src/profiles/profile.ts';
import { classifyComposer, readScreen } from '../src/watch/screen.ts';
import { documentOf, coverageOf, readOf, type Kind } from './coverage.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures');
const manifestFile = join(fixtures, 'conformance.json');
const coverageFile = join(root, 'contract', 'capture-coverage.json');

/** The baseline set from the design note: one file per stage, and what the screen must read as. */
export type StageName = 'trust' | 'idle' | 'unsent' | 'working' | 'question' | 'permission' | 'exit';
export const BASELINE_STAGES: readonly StageName[] = ['trust', 'idle', 'unsent', 'working', 'question', 'permission', 'exit'];

/** The manifest entry each stage writes, and what its capture must read as. Exit reads unknown. */
export function stageOf(stage: StageName): { file: string; classify: Kind; composer: string } {
  switch (stage) {
    case 'trust':
      return { file: 'trust.txt', classify: 'trust', composer: 'unknown' };
    case 'idle':
      return { file: 'idle.txt', classify: 'idle', composer: 'idle' };
    case 'unsent':
      return { file: 'unsent.txt', classify: 'unsent', composer: 'unsent' };
    case 'working':
      return { file: 'working.txt', classify: 'working', composer: 'idle' };
    case 'question':
      return { file: 'question.txt', classify: 'question', composer: 'unknown' };
    case 'permission':
      return { file: 'permission.txt', classify: 'permission', composer: 'unknown' };
    case 'exit':
      return { file: 'exit.txt', classify: 'unknown', composer: 'unknown' };
  }
}

/** The baseline kinds a version folder still owes: the manifest has no entry for the stage's
 *  file (from this run or an earlier one) and the folder README does not state its kind under
 *  `## Not produced`. */
export function owedOf(cli: string, version: string, manifestFiles: readonly string[], readme: string): StageName[] {
  const read = readOf(readme);
  return BASELINE_STAGES.filter((stage) => {
    const { file, classify } = stageOf(stage);
    return !manifestFiles.includes(`${cli}/${version}/${file}`) && !read.notProduced.has(classify);
  });
}

export type ScrubOptions = {
  /** The throwaway workspace whose path every form of is replaced with `<workspace>`. */
  workspaceDir: string;
  /** The operator's home, replaced with `<home>` so no real path reaches a fixture. */
  homeDir?: string;
  /** A session/conversation id seen in the run, replaced wherever it appears. */
  sessionId?: string;
  /** The account name or address, replaced wherever it appears. */
  account?: string;
  /** The plan tier word, replaced wherever it appears. */
  plan?: string;
};

/** A placeholder padded to the width of the text it stands in for, so a box row keeps its
 *  columns and a dialog keeps its indentation. Line count and every other character are
 *  untouched: nothing here reflows a screen. */
function standingFor(text: string, placeholder: string): string {
  return placeholder.length >= text.length ? placeholder : placeholder.padEnd(text.length, ' ');
}

function replaceAll(text: string, needle: string, placeholder: string): string {
  if (needle === '') return text;
  const padded = standingFor(needle, placeholder);
  return text.split(needle).join(padded);
}

/** The forms a workspace path can take in a pane: the path itself, its realpath, and its
 *  `~/...` spelling when it sits under the home folder. Longest first, so a shorter form
 *  never eats part of a longer one. */
export function workspaceForms(workspaceDir: string, homeDir: string): string[] {
  const forms = new Set<string>([workspaceDir]);
  try {
    forms.add(realpathSync(workspaceDir));
  } catch {
    // A workspace the script already removed has no realpath; the plain form is enough.
  }
  for (const form of [...forms]) {
    if (homeDir !== '' && form.startsWith(`${homeDir}/`)) forms.add(`~${form.slice(homeDir.length)}`);
  }
  return [...forms].filter((form) => form !== '').sort((a, b) => b.length - a.length);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Replaces every identifier a pane can show with a stable placeholder, preserving line count,
 *  indentation and column widths. Deterministic: the same raw screen and options always scrub
 *  to the same bytes. */
export function scrubCapture(raw: string, options: ScrubOptions): string {
  let text = raw;
  for (const form of workspaceForms(options.workspaceDir, options.homeDir ?? homedir())) {
    text = replaceAll(text, form, '<workspace>');
  }
  // A pane may wrap a long path across two rows, so the full form above misses it. The
  // folder's own unique name is the part that identifies this run; replace it wherever the
  // wrap put it, padded so the row keeps its columns.
  if (options.workspaceDir !== '') text = replaceAll(text, pathBasename(options.workspaceDir), '<workspace>');
  if (options.homeDir !== undefined && options.homeDir !== '') {
    text = replaceAll(text, options.homeDir, '<home>');
  }
  if (options.sessionId !== undefined && options.sessionId !== '') {
    text = replaceAll(text, options.sessionId, '<session-id>');
  }
  text = text.replace(UUID, (match) => standingFor(match, '<session-id>'));
  if (options.account !== undefined && options.account !== '') {
    text = replaceAll(text, options.account, '<account>');
  }
  text = text.replace(EMAIL, (match) => standingFor(match, '<account>'));
  if (options.plan !== undefined && options.plan !== '') {
    text = replaceAll(text, options.plan, '<plan>');
  }
  // A resume line names the id the CLI will take next, in whatever spelling that CLI uses: a
  // UUID is handled above, and a bare hex id of eight or more digits on a resume line is
  // replaced here. Other lines are left alone, so hashes in ordinary output stay readable.
  return text
    .split('\n')
    .map((line) => (/\bresume\b/i.test(line) ? line.replace(/\b[0-9a-f]{8,}\b/gi, (match) => standingFor(match, '<session-id>')) : line))
    .join('\n');
}

type ManifestScreen = { file: string; cli: string; classify: string; composer: string; provenance?: string };
type Manifest = { screens: ManifestScreen[]; yaml: unknown[] };

/** The manifest with the given captures registered, sorted by file. An entry already present is
 *  replaced, so a re-capture updates its kinds instead of duplicating the file. */
export function manifestWith(text: string, captures: ManifestScreen[]): string {
  const manifest = JSON.parse(text) as Manifest;
  const byFile = new Map(manifest.screens.map((screen) => [screen.file, screen]));
  for (const capture of captures) byFile.set(capture.file, { ...capture, provenance: 'capture' });
  const screens = [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return `${JSON.stringify({ ...manifest, screens }, null, 2)}\n`;
}

/** The profile YAML with the top-level `tested.to` set to the given version. The nested
 *  per-CLI records under other keys are not touched. */
export function bumpTestedTo(yamlText: string, version: string): string {
  return yamlText.replace(/^tested:\n(  from: .*\n)  to: .*$/m, (_match, from: string) => `tested:\n${from}  to: '${version}'`);
}

/** The README a fresh version folder gets: what was captured, by what, and the place the
 *  operator must state any kind the CLI does not produce. */
export function readmeStub(cli: string, version: string, versionText: string, slices: { stage: StageName; styled: boolean }[], herdrVersion: string): string {
  const rows = slices.map(({ stage }) => {
    const { file, classify: kind } = stageOf(stage);
    return `- \`${file}\`: the \`${kind}\` screen, captured in a scratch session created for the purpose and stopped afterwards.`;
  });
  const plain = slices.every(({ styled }) => !styled) ? 'plain' : 'ansi';
  return [
    `# ${cli} ${version} terminal captures`,
    '',
    `Captured from the installed macOS ${cli} CLI with herdr ${herdrVersion}, \`pane read --source visible --lines 200\` (${plain}),`,
    'in a scratch session created for the purpose and stopped afterwards. ' +
      `The binary's \`--version\` printed \`${versionText.trim()}\`. Directory paths are \`<workspace>\`.`,
    '',
    ...rows,
    '',
    '## Not produced',
    '',
    'A baseline kind the CLI does not emit in a fresh scratch run is stated here, with the reason.',
    '',
  ].join('\n');
}

/** The one-shot command that asks a CLI for its version. */
function versionTextOf(binary: string): string {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout.trim() : '';
  }
}

/** herdr's version, for the README header. */
function herdrVersion(): string {
  try {
    return execFileSync('herdr', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'an unread version';
  }
}

function usage(): string {
  return [
    'Usage: bun scripts/capture-cli.ts --cli <cli> [options]',
    '',
    '  --cli <cli>            the profile to capture (codex, claude-code, cursor, ...)',
    '  --stage <name>         capture one stage: trust, idle, unsent, working, question,',
    '                         permission, exit; repeatable. Default: trust, idle, unsent, exit.',
    '  --prompt <text>        the prompt typed into the idle composer for working/question/',
    '                         permission. Required for those three stages.',
    '  --launch <line>        the launch line for the seated stages. Default: the profile',
    '                         binary with its unattended options.',
    '  --trust-launch <line>  the launch line for the trust stage. Default: the profile binary.',
    '  --trust-answer <keys>  comma-separated herdr key names that mark the trust row and confirm',
    '                         it, sent after the trust capture so idle can follow. Default: enter.',
    '  --prepare <dir>        copy this directory\'s contents into the throwaway workspace before',
    '                         launching (a project-local config or rules the stage needs)',
    '  --probe <text>         the text typed and never sent for unsent. Default: Fix the failing test',
    '  --account <text>       the account name or address to scrub from every capture',
    '  --plan <text>          the plan tier word to scrub from every capture',
    '  --timeout <seconds>    how long a stage waits for its screen. Default: 90, or the profile.',
    '  --write                write fixtures, manifest, README when absent, and the contract',
    '  --plain                strip the pane read\'s ANSI styling before scrubbing and writing',
    '  --keep                 keep the scratch session and temp folder for a failed run',
    '',
  ].join('\n');
}

type Options = {
  cli: string;
  stages: StageName[];
  prompt: string | null;
  launch: string | null;
  trustLaunch: string | null;
  trustAnswer: string;
  prepare: string | null;
  probe: string;
  timeoutSeconds: number | null;
  account: string | null;
  plan: string | null;
  write: boolean;
  plain: boolean;
  keep: boolean;
};

function parseArgs(argv: string[]): Options | { error: string } {
  const options: Options = {
    cli: '',
    stages: [],
    prompt: null,
    launch: null,
    trustLaunch: null,
    trustAnswer: 'enter',
    prepare: null,
    probe: 'Fix the failing test',
    timeoutSeconds: null,
    account: null,
    plan: null,
    write: false,
    plain: false,
    keep: false,
  };
  const stages: StageName[] = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] ?? '';
    const value = (): string => {
      const next = argv[++at];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--cli') options.cli = value();
    else if (arg === '--stage') {
      const name = value();
      if (!BASELINE_STAGES.includes(name as StageName)) return { error: `--stage "${name}" is not one of ${BASELINE_STAGES.join(', ')}` };
      stages.push(name as StageName);
    } else if (arg === '--prompt') options.prompt = value();
    else if (arg === '--launch') options.launch = value();
    else if (arg === '--trust-launch') options.trustLaunch = value();
    else if (arg === '--trust-answer') options.trustAnswer = value();
    else if (arg === '--prepare') options.prepare = value();
    else if (arg === '--probe') options.probe = value();
    else if (arg === '--account') options.account = value();
    else if (arg === '--plan') options.plan = value();
    else if (arg === '--timeout') {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds <= 0) return { error: '--timeout needs a positive number of seconds' };
      options.timeoutSeconds = seconds;
    } else if (arg === '--write') options.write = true;
    else if (arg === '--plain') options.plain = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') return { error: '__help__' };
    else return { error: `unknown option "${arg}"` };
  }
  if (options.cli === '') return { error: '--cli is required' };
  options.stages = stages.length > 0 ? stages : ['trust', 'idle', 'unsent', 'exit'];
  for (const stage of options.stages) {
    if ((stage === 'working' || stage === 'question' || stage === 'permission') && options.prompt === null) {
      return { error: `--stage ${stage} needs --prompt: the prompt typed into the idle composer that provokes the screen` };
    }
  }
  return options;
}

/** Runs a launch line in the pane, with herdr's own refusal text when it says no. */
function launchInPane(pane: string, command: string, session: string): string | null {
  try {
    execFileSync('herdr', ['--session', session, 'pane', 'run', pane, command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    return null;
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string };
    return (failure.stderr ?? '').trim() || (failure.stdout ?? '').trim() || failure.message || 'pane run exited non-zero';
  }
}

/** Polls the pane until the screen reads as the wanted kind, or the deadline passes. */
function waitForKind(pane: string, session: string, cli: string, kind: string, deadline: number): string | null {
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = paneRead(pane, 200, session);
    if (last !== null && readScreen(cli, last).kind === kind) return last;
    Bun.sleepSync(500);
  }
  return null;
}

/** What the pane reads as now and its last few non-empty rows, for a stage that timed out. */
function describeScreen(pane: string, session: string, cli: string): string {
  const raw = paneRead(pane, 200, session);
  if (raw === null) return 'the pane could not be read';
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  return `the pane read ${readScreen(cli, raw).kind}; last rows: ${lines.slice(-4).join(' / ')}`;
}

/** Sends the comma-separated keys the operator named, one `pane send-keys` each. */
function sendKeys(pane: string, session: string, keys: string): boolean {
  for (const key of keys.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    if (!sendKey(pane, key, session)) return false;
    Bun.sleepSync(150);
  }
  return true;
}

type Captured = { stage: StageName; screen: string; styled: boolean };

/** Runs one scratch session and takes the requested stages in order. */
function runStages(options: Options, profile: NonNullable<ReturnType<typeof profileFor>>): Captured[] {
  // The design note names `join(tmpdir(), 'team-capture-')`; on macOS that is the long
  // /var/folders path, which a 51-column trust dialog wraps across two rows and so defeats the
  // path scrub. /tmp is the same throwaway under a short name, and its /private/tmp realpath
  // still fits on one row.
  const workspaceRoot = process.platform === 'darwin' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const workspaceDir = mkdtempSync(join(workspaceRoot, 'team-capture-'));
  const session = `capture-${options.cli.replace(/[^a-z0-9-]/gi, '-')}-${process.pid}`;
  const saved: Captured[] = [];
  let workspace = '';
  let pane = '';
  const settle = (seconds: number): number => Date.now() + seconds * 1000;
  const timeout = options.timeoutSeconds ?? Math.max(30, profile.idleTimeout);
  const launchOf = (stage: StageName): string =>
    stage === 'trust'
      ? options.trustLaunch ?? profile.binary
      : options.launch ?? [profile.binary, ...profile.unattended].join(' ');

  try {
    if (options.prepare !== null) {
      // Capture-only settings the stage needs (a project-local config or rules directory) are
      // staged from the operator's scratch folder into the throwaway workspace and leave with it.
      if (!existsSync(options.prepare)) throw new Error(`--prepare ${options.prepare} does not exist`);
      execFileSync('cp', ['-R', `${options.prepare}/.`, workspaceDir], { timeout: 20_000 });
    }
    execFileSync('git', ['init', '-q'], { cwd: workspaceDir, timeout: 20_000 });
    if (!startServer(session)) throw new Error(`herdr session ${session} could not start`);
    // The server is spawned detached; its socket appears a moment later. Retry rather than
    // treat that first refusal as a broken session.
    let created: { pane: string; workspace: string } | null = null;
    const readyUntil = settle(20);
    while (created === null && Date.now() < readyUntil) {
      created = workspaceCreate(workspaceDir, 'capture', session);
      if (created === null) Bun.sleepSync(300);
    }
    if (created === null) throw new Error('herdr workspace create answered no pane');
    workspace = created.workspace;
    pane = created.pane;

    /** Saves the screen after checking it reads as the stage's kind, and scrubs the throwaway
     *  workspace out of it before it can reach a file. */
    const take = (stage: StageName, raw: string): Captured => {
      const expected = stageOf(stage);
      const read = readScreen(options.cli, raw);
      if (read.kind !== expected.classify) {
        throw new Error(`${stage}: expected the screen to read ${expected.classify}, but it read ${read.kind}; fix the profile rule before capturing`);
      }
      const composer = classifyComposer(options.cli, raw.split('\n')).kind;
      if (expected.composer !== 'unknown' && composer !== expected.composer) {
        throw new Error(`${stage}: expected the composer to read ${expected.composer}, but it read ${composer}`);
      }
      // The unsent capture must also prove the text is still in the box, as delivery reads it;
      // a kind alone does not say the composer holds what was typed.
      if (stage === 'unsent' && !boxHoldsText(options.cli, options.probe, raw)) {
        throw new Error('unsent: the composer does not read back as holding the probe text');
      }
      const cleaned = options.plain ? stripSgr(raw) : raw;
      const screen = scrubCapture(cleaned, {
        workspaceDir,
        homeDir: homedir(),
        account: options.account ?? undefined,
        plan: options.plan ?? undefined,
      });
      const captured: Captured = { stage, screen, styled: !options.plain && /\u001b\[/.test(raw) };
      saved.push(captured);
      return captured;
    };

    /** Waits for the idle prompt, answering the trust question with the operator's keys the
     *  first time it is drawn. A launch and its dialog arrive after `pane run` returns, so the
     *  answer has to be given while polling, not by reading the screen once. */
    const reachIdle = (deadline: number): string | null => {
      let trustAnswered = false;
      while (Date.now() < deadline) {
        const raw = paneRead(pane, 200, session);
        if (raw !== null) {
          const kind = readScreen(options.cli, raw).kind;
          if (kind === 'idle') return raw;
          if (kind === 'trust' && !trustAnswered) {
            if (!sendKeys(pane, session, options.trustAnswer)) throw new Error('sending the trust answer failed');
            trustAnswered = true;
            Bun.sleepSync(500);
            continue;
          }
        }
        Bun.sleepSync(500);
      }
      return null;
    };

    // The trust stage launches untrusted and captures the question before anything is
    // answered; the operator's keys then mark the row so the seated stages can follow.
    let launched = false;
    if (options.stages.includes('trust')) {
      const refused = launchInPane(pane, launchOf('trust'), session);
      if (refused !== null) throw new Error(`pane run failed for the trust launch: ${refused}`);
      const raw = waitForKind(pane, session, options.cli, 'trust', settle(timeout));
      if (raw === null) throw new Error('trust: no trust screen appeared; the CLI may show none in this folder');
      take('trust', raw);
      if (!sendKeys(pane, session, options.trustAnswer)) throw new Error('trust: sending the trust answer failed');
      const answeredUntil = settle(timeout);
      while (Date.now() < answeredUntil) {
        if (paneShellBack(pane, session) === true) break;
        const now = paneRead(pane, 200, session);
        if (now !== null && readScreen(options.cli, now).kind === 'idle') break;
        Bun.sleepSync(500);
      }
      launched = paneShellBack(pane, session) !== true;
    }

    const needsSeated = options.stages.some((stage) => stage !== 'trust');
    if (needsSeated) {
      if (!launched) {
        const refused = launchInPane(pane, launchOf('idle'), session);
        if (refused !== null) throw new Error(`pane run failed for the seated launch: ${refused}`);
      }
      const idle = reachIdle(settle(timeout));
      if (idle === null) throw new Error('no idle screen appeared after the launch');
      if (options.stages.includes('idle')) take('idle', idle);

      if (options.stages.includes('unsent')) {
        if (!typeText(pane, options.probe, session)) throw new Error('unsent: pane send-text failed');
        const rawUnsent = waitForKind(pane, session, options.cli, 'unsent', settle(30));
        if (rawUnsent === null) throw new Error('unsent: the probe did not read as an unsent composer');
        take('unsent', rawUnsent);
        sendKey(pane, profile.exitClear ?? 'ctrl+c', session);
        Bun.sleepSync(500);
      }

      for (const stage of ['working', 'question', 'permission'] as const) {
        if (!options.stages.includes(stage) || options.prompt === null) continue;
        // The composer must be idle before the prompt, and one prompt usually provokes one of
        // the three; a stage named alone gets its own run.
        const idle = waitForKind(pane, session, options.cli, 'idle', settle(30));
        if (idle === null) throw new Error(`${stage}: the composer did not return to idle before the prompt`);
        if (!typeText(pane, options.prompt, session)) throw new Error(`${stage}: pane send-text failed`);
        // A long prompt is a paste: Enter sent while it is still settling is swallowed and the
        // text sits in the composer. Wait for the composer to hold it before pressing Enter.
        if (waitForKind(pane, session, options.cli, 'unsent', settle(10)) === null) {
          process.stderr.write(`${stage}: the composer did not read unsent after the prompt; sending Enter anyway\n`);
        }
        if (!pressEnter(pane, session)) throw new Error(`${stage}: the Enter for the prompt failed`);
        const rawKind = waitForKind(pane, session, options.cli, stage, settle(timeout));
        if (rawKind === null) throw new Error(`${stage}: the prompt did not produce a ${stage} screen; ${describeScreen(pane, session, options.cli)}`);
        take(stage, rawKind);
        if (stage !== 'working') {
          sendKey(pane, 'escape', session);
          Bun.sleepSync(500);
        }
      }

      if (options.stages.includes('exit')) {
        const idle = waitForKind(pane, session, options.cli, 'idle', settle(30));
        if (idle === null) throw new Error('exit: the composer did not return to idle before the exit text');
        if (profile.exit === null) throw new Error('exit: the profile declares no exit text');
        if (!typeText(pane, profile.exit, session)) throw new Error('exit: pane send-text failed');
        if (!pressEnter(pane, session)) throw new Error('exit: the Enter for the exit text failed');
        const deadline = settle(profile.exitTimeout);
        while (Date.now() < deadline && paneShellBack(pane, session) !== true) Bun.sleepSync(500);
        if (paneShellBack(pane, session) !== true) throw new Error(`exit: the pane did not return to its shell; ${describeScreen(pane, session, options.cli)}`);
        const rawExit = paneRead(pane, 200, session);
        if (rawExit === null) throw new Error('exit: the pane could not be read after the shell came back');
        take('exit', rawExit);
      }
    }
    return saved;
  } finally {
    if (options.keep) {
      process.stderr.write(`capture: kept ${workspaceDir} and herdr session ${session}\n`);
    } else {
      if (workspace !== '') workspaceClose(workspace, session);
      sessionStop(session);
      sessionDelete(session);
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

/** Writes the captures, registers them, and (when the whole baseline set was taken) bumps the
 *  profile and regenerates the contract. Returns the lines to print. */
function writeCaptures(options: Options, version: string, versionText: string, captures: Captured[]): string[] {
  const dir = join(fixtures, options.cli, version);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const entries: ManifestScreen[] = [];
  for (const { stage, screen } of captures) {
    const { file, classify: kind, composer } = stageOf(stage);
    writeFileSync(join(dir, file), screen.endsWith('\n') ? screen : `${screen}\n`);
    entries.push({ file: `${options.cli}/${version}/${file}`, cli: options.cli, classify: kind, composer });
    lines.push(`wrote test/fixtures/${options.cli}/${version}/${file} (${kind})`);
  }
  writeFileSync(manifestFile, manifestWith(readFileSync(manifestFile, 'utf8'), entries));
  lines.push(`registered ${entries.length} capture(s) in test/fixtures/conformance.json`);
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) {
    const slices = captures.map(({ stage, styled }) => ({ stage, styled }));
    writeFileSync(readme, readmeStub(options.cli, version, versionText, slices, herdrVersion()));
    lines.push(`wrote test/fixtures/${options.cli}/${version}/README.md`);
  }
  // What the folder owes is its state on disk, not this run's stages: a kind is accounted for
  // when the manifest lists a capture for its file (one from this run or an earlier one) or the
  // folder README states it under ## Not produced.
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { screens: { file: string }[] };
  const owed = owedOf(options.cli, version, manifest.screens.map((screen) => screen.file), readFileSync(readme, 'utf8'));
  if (owed.length > 0) {
    lines.push(`baseline kinds still owed for ${options.cli}/${version}: ${owed.map((stage) => `${stageOf(stage).file} (${stage})`).join(', ')}`);
    lines.push('state each one under ## Not produced in the folder README if the CLI does not produce it');
  }
  const profile = profileFor(options.cli);
  const profileFile = join(root, 'src', 'profiles', `${options.cli}.yaml`);
  // The folder is complete when nothing is owed: either this run (or an earlier one at the same
  // version) captured every remaining kind, or the README states it under ## Not produced.
  const all = owed.length === 0;
  if (all && profile !== null && parseVersion(version) !== null) {
    const bumped = bumpTestedTo(readFileSync(profileFile, 'utf8'), version);
    if (bumped !== readFileSync(profileFile, 'utf8')) {
      writeFileSync(profileFile, bumped);
      lines.push(`bumped src/profiles/${options.cli}.yaml tested.to to ${version}`);
    }
  }
  const { problems } = coverageOf();
  if (problems.length === 0) {
    writeFileSync(coverageFile, documentOf());
    lines.push('wrote contract/capture-coverage.json');
  } else {
    lines.push('contract/capture-coverage.json left unchanged; the coverage gate still reports:');
    for (const problem of problems) lines.push(`  ${problem}`);
  }
  return lines;
}

function main(argv: string[]): number {
  const options = parseArgs(argv);
  if ('error' in options) {
    if (options.error === '__help__') {
      process.stdout.write(usage());
      return 0;
    }
    process.stderr.write(`capture: ${options.error}\n\n${usage()}`);
    return 2;
  }
  const profile = profileFor(options.cli);
  if (profile === null) {
    process.stderr.write(`capture: no shipped profile for "${options.cli}"\n`);
    return 2;
  }
  const versionText = versionTextOf(profile.binary);
  const numbers = parseVersion(versionText);
  if (numbers === null) {
    process.stderr.write(`capture: could not read a version from "${profile.binary} --version" (${JSON.stringify(versionText)})\n`);
    return 2;
  }
  const version = numbers.join('.');
  let captures: Captured[];
  try {
    captures = runStages(options, profile);
  } catch (error) {
    process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const { stage, screen } of captures) process.stdout.write(`captured ${stage} (${screen.split('\n').length} lines)\n`);
  if (!options.write) {
    process.stdout.write('dry run: nothing written; pass --write to write the fixtures\n');
    return 0;
  }
  try {
    for (const line of writeCaptures(options, version, versionText, captures)) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
