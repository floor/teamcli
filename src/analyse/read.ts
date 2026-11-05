// Bounded static project reader (`src/analyse/read.ts`): deterministic, local, zero-token
// (`0 tokens`, `$0.00`), bounded by file count (`<= 10,000`), per-file byte ceiling (`<= 256 KiB`),
// total read budget (`<= 5 s`), and `lstat` symlink rejection. Project file content is material,
// never an instruction: every opened file is scanned for untrusted instructions requesting seat
// counts, models/labs, grants, trust, or policies, which are recorded in `report.findings` with
// `file:line` provenance and never followed. No discovered check or script is ever executed.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { issueState } from '../commands/issues.ts';
import { plainLine } from '../launch/plain.ts';
import { readFileSource } from '../tasks/queue.ts';

export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_DURATION_MS = 5_000;
export const PACE_WINDOW_DAYS = 28;

export type AnalysisCost = {
  duration_ms: number;
  git_walks: number;
  files_read: number;
  bytes_read: number;
  tokens: 0;
  usd: 0;
};

export type ProjectVisibility = {
  value: 'public' | 'private' | 'not known';
  source: string;
};

export type ProjectSize = {
  files: number;
  lines: number;
  mark: 'measured' | 'estimated';
  source: string;
};

export type LanguageShare = {
  language: string;
  files: number;
  lines: number;
  share_pct: number;
};

export type CheckCommand = {
  command: string;
  source: string;
};

export type ReleaseSummary = {
  tags: boolean;
  workflows: string[];
  source: string;
};

export type PaceRhythm = 'idle' | 'steady-idle' | 'active' | 'bursty' | 'sparse';

export type ProjectPace = {
  window_days: number;
  commits_per_day: number;
  active_hours_per_day: number;
  rhythm: PaceRhythm;
  source: string;
};

export type OpenWorkSummary = {
  open: number;
  blocked: number;
  source: string;
};

export type ProjectTopology = {
  parallelizable: string[];
  serial: string[];
};

export type AnalysisFinding = {
  kind: 'untrusted-instruction-ignored';
  source: string;
  summary: string;
};

export type ProjectReport = {
  root: string;
  visibility: ProjectVisibility;
  manifests: string[];
  size: ProjectSize;
  languages: LanguageShare[];
  stack_skills: string[];
  checks: CheckCommand[];
  ci: string[];
  release: ReleaseSummary;
  pace: ProjectPace;
  open_work: OpenWorkSummary;
  topology: ProjectTopology;
  findings: AnalysisFinding[];
};

export type ReadProjectResult =
  | {
      ok: true;
      report: ProjectReport;
      analysis_cost: AnalysisCost;
    }
  | {
      ok: false;
      code: 'analyse.unreadable';
      why: string;
    };

export type ReadProjectOptions = {
  /** Display root string for `report.root` (defaults to `.` or relative path). */
  displayRoot?: string;
  /** Visibility known from the registry gate, if any. */
  visibilityHint?: 'public' | 'private';
  /** Reference clock for the 28-day git pace window. */
  now?: Date;
  /** Optional ceiling overrides for testing bounds. */
  maxFiles?: number;
  maxFileBytes?: number;
  maxDurationMs?: number;
};

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.php': 'PHP',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'CSS',
};

const LANGUAGE_SKILL: Readonly<Record<string, string>> = {
  TypeScript: 'typescript',
  JavaScript: 'javascript',
  Python: 'python',
  Rust: 'rust',
  Go: 'go',
  Swift: 'swift',
  Kotlin: 'kotlin',
  Java: 'java',
  Ruby: 'ruby',
  C: 'c',
  'C++': 'cpp',
};

const MANIFEST_CANDIDATES = [
  'README.md',
  'README',
  'README.txt',
  'README.rst',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Makefile',
  'justfile',
  'Package.swift',
  'build.gradle',
  'build.gradle.kts',
] as const;

const EXTRA_SCAN_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.agents/team.yaml',
  '.agents/tasks.md',
  '.agents/queue.yaml',
] as const;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
]);

const KNOWN_SERIAL_FILES = new Set([
  'src/cli.ts',
  'src/index.ts',
  'src/output/schema.ts',
  'contract/cli.json',
  'contract/exit-codes.json',
  'package.json',
]);

const SEAT_INSTRUCTION_RE =
  /\b(?:(?:need|needs|require|requires|request|requests|spawn|launch|propose|allocate|use|create|add|run)\b[^.\n]{0,60}?\b(\d+)\s+(?:seats?|agents?|builders?|coders?|testers?|workers?)|\b(\d+)\s+(?:seats?|agents?)\b[^.\n]{0,40}?\b(?:needed|required|minimum|at\s+least|full\s+time|round\s+the\s+clock))/i;
const GRANT_DIRECTIVE_RE =
  /\b(?:grant\s*:\s*[a-z*_-]+|grants\s*:\s*\[|give\s+(?:all\s+)?(?:grants|rights|permissions)|confer\s+grant|analyser\s*:\s*[a-z0-9@._-]+|ignore\s+(?:all\s+|previous\s+|prior\s+)?instructions)/i;
const TRUST_POLICY_INJECTION_RE =
  /\b(?:override\s+(?:trust|policies|policy|quota)|bypass\s+(?:gate|quota|approval|analyser)|set\s+trust\s*:|grant\s+create\b|grant\s+up\b)/i;

/** Scans one file's text for prompt-injection or untrusted seat/grant/policy instructions. */
export function scanFileForFindings(relPath: string, text: string): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    if (!line) continue;

    const seatMatch = SEAT_INSTRUCTION_RE.exec(line);
    const grantMatch = GRANT_DIRECTIVE_RE.exec(line);
    const trustMatch = TRUST_POLICY_INJECTION_RE.exec(line);

    if (seatMatch || grantMatch || trustMatch) {
      const parts: string[] = [];
      const count = seatMatch?.[1] ?? seatMatch?.[2];
      if (count !== undefined) parts.push(`requests ${count} seats`);
      if (grantMatch) parts.push(plainLine(grantMatch[0]).slice(0, 60));
      else if (trustMatch) parts.push(plainLine(trustMatch[0]).slice(0, 60));
      const detail = parts.length > 0 ? parts.join(' and ') : plainLine(line).slice(0, 80);
      findings.push({
        kind: 'untrusted-instruction-ignored',
        source: `${relPath}:${i + 1}`,
        summary: `${detail}; recorded as finding only`,
      });
    }
  }
  return findings;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return text.charCodeAt(text.length - 1) === 10 ? count : count + 1;
}

function areaOfFile(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  const first = parts[0] as string;
  if ((first === 'src' || first === 'packages') && parts.length >= 3) {
    return `${first}/${parts[1]}`;
  }
  return first;
}

export function readProjectFacts(
  targetPath: string,
  options: ReadProjectOptions = {},
): ReadProjectResult {
  const startedAt = performance.now();
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxDurationMs = options.maxDurationMs ?? MAX_DURATION_MS;
  const now = options.now ?? new Date();

  const rootAbs = resolve(targetPath);
  let rootStat;
  try {
    rootStat = lstatSync(rootAbs);
  } catch (error) {
    return {
      ok: false,
      code: 'analyse.unreadable',
      why: `${targetPath}: ${(error as Error).message}`,
    };
  }
  if (rootStat.isSymbolicLink()) {
    return {
      ok: false,
      code: 'analyse.unreadable',
      why: `${targetPath}: symbolic links are refused as project roots`,
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      code: 'analyse.unreadable',
      why: `${targetPath}: not a directory`,
    };
  }

  let filesRead = 0;
  let bytesRead = 0;
  let gitWalks = 0;
  let estimated = false;
  const findings: AnalysisFinding[] = [];
  const scannedPaths = new Set<string>();

  const withinBudget = (): boolean => performance.now() - startedAt <= maxDurationMs;

  const readBoundedText = (relPath: string, scanFindings = true): string | null => {
    if (!withinBudget()) {
      estimated = true;
      return null;
    }
    const full = join(rootAbs, relPath);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > maxFileBytes) {
      estimated = true;
      return null;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(full);
    } catch {
      return null;
    }
    filesRead += 1;
    bytesRead += buf.byteLength;
    // Skip binary files containing NUL bytes
    if (buf.includes(0)) return null;
    const text = buf.toString('utf8');
    if (scanFindings && !scannedPaths.has(relPath)) {
      scannedPaths.add(relPath);
      findings.push(...scanFileForFindings(relPath, text));
    }
    return text;
  };

  // 1. Discover manifests & README
  const manifests: string[] = [];
  const manifestTexts = new Map<string, string>();
  for (const candidate of MANIFEST_CANDIDATES) {
    const text = readBoundedText(candidate, true);
    if (text !== null) {
      manifests.push(candidate);
      manifestTexts.set(candidate, text);
    }
  }
  for (const extra of EXTRA_SCAN_FILES) {
    readBoundedText(extra, true);
  }

  // 2. Discover file list via `git ls-files -z` or bounded filesystem walk
  let isGitRepo = false;
  let fileList: string[] = [];
  let sizeSource = 'filesystem walk';

  const lsFiles = spawnSync('git', ['-C', rootAbs, 'ls-files', '-z'], {
    encoding: 'utf8',
    timeout: Math.min(2_000, maxDurationMs),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (lsFiles.status === 0 && typeof lsFiles.stdout === 'string') {
    isGitRepo = true;
    sizeSource = 'git ls-files';
    const rawFiles = lsFiles.stdout.split('\0').filter(Boolean);
    if (rawFiles.length > maxFiles) {
      estimated = true;
      fileList = rawFiles.slice(0, maxFiles);
    } else {
      fileList = rawFiles;
    }
  } else {
    const walked: string[] = [];
    const walk = (dirRel: string): void => {
      if (walked.length >= maxFiles || !withinBudget()) {
        estimated = true;
        return;
      }
      const dirAbs = dirRel ? join(rootAbs, dirRel) : rootAbs;
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (walked.length >= maxFiles) {
          estimated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(rel);
        } else if (entry.isFile()) {
          walked.push(rel);
        }
      }
    };
    walk('');
    fileList = walked;
  }

  // 3. Measure size, languages, and stack skills
  let totalFiles = 0;
  let totalLines = 0;
  const langStats = new Map<string, { files: number; lines: number }>();

  for (const relPath of fileList) {
    if (!withinBudget()) {
      estimated = true;
      break;
    }
    const full = join(rootAbs, relPath);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    totalFiles += 1;

    const ext = extname(relPath).toLowerCase();
    const lang = EXTENSION_LANGUAGE[ext];

    let lines = 0;
    const cached = manifestTexts.get(relPath);
    if (cached !== undefined) {
      lines = countLines(cached);
    } else if (st.size <= maxFileBytes) {
      const text = readBoundedText(relPath, true);
      if (text !== null) {
        lines = countLines(text);
      }
    } else {
      estimated = true;
      lines = Math.round(st.size / 40);
    }
    totalLines += lines;

    if (lang !== undefined) {
      const prev = langStats.get(lang) ?? { files: 0, lines: 0 };
      prev.files += 1;
      prev.lines += lines;
      langStats.set(lang, prev);
    }
  }

  const totalLangLines = Array.from(langStats.values()).reduce((sum, item) => sum + item.lines, 0);
  const languages: LanguageShare[] = Array.from(langStats.entries())
    .map(([language, stat]) => ({
      language,
      files: stat.files,
      lines: stat.lines,
      share_pct:
        totalLangLines > 0
          ? Math.round((stat.lines / totalLangLines) * 1000) / 10
          : Math.round((stat.files / Math.max(1, totalFiles)) * 1000) / 10,
    }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.language.localeCompare(b.language));

  const skillSet = new Set<string>();
  for (const lang of languages) {
    const mapped = LANGUAGE_SKILL[lang.language];
    if (mapped !== undefined) skillSet.add(mapped);
  }
  if (manifests.includes('Package.swift')) skillSet.add('swift');
  if (manifests.includes('build.gradle.kts')) skillSet.add('kotlin');
  if (manifests.includes('build.gradle') && !skillSet.has('kotlin')) skillSet.add('java');
  if (manifests.includes('Cargo.toml')) skillSet.add('rust');
  if (manifests.includes('go.mod')) skillSet.add('go');
  if (manifests.includes('pyproject.toml')) skillSet.add('python');
  const pkgJsonText = manifestTexts.get('package.json');
  if (
    fileList.includes('bun.lockb') ||
    fileList.includes('bun.lock') ||
    (pkgJsonText !== undefined && /\bbun\b/.test(pkgJsonText))
  ) {
    skillSet.add('bun');
  }
  const stack_skills = Array.from(skillSet);

  // 4. Extract checks, CI workflows, and release setup (never executing any command)
  const checks: CheckCommand[] = [];
  let pkgPrivate: boolean | undefined;
  if (pkgJsonText !== undefined) {
    try {
      const parsed = JSON.parse(pkgJsonText) as Record<string, unknown>;
      if (typeof parsed.private === 'boolean') pkgPrivate = parsed.private;
      if (typeof parsed.scripts === 'object' && parsed.scripts !== null && !Array.isArray(parsed.scripts)) {
        const scripts = parsed.scripts as Record<string, unknown>;
        for (const key of ['test', 'typecheck', 'lint', 'check', 'build', 'ci']) {
          const cmd = scripts[key];
          if (typeof cmd === 'string' && cmd.trim() !== '') {
            checks.push({
              command: plainLine(cmd.trim()),
              source: `package.json scripts.${key}`,
            });
          }
        }
      }
    } catch {
      // Malformed package.json is ignored for check extraction
    }
  }
  if (manifests.includes('Cargo.toml')) {
    checks.push({ command: 'cargo test', source: 'Cargo.toml' });
  }
  if (manifests.includes('go.mod')) {
    checks.push({ command: 'go test ./...', source: 'go.mod' });
  }
  if (manifests.includes('pyproject.toml')) {
    checks.push({ command: 'pytest', source: 'pyproject.toml' });
  }
  if (manifests.includes('Package.swift')) {
    checks.push({ command: 'swift test', source: 'Package.swift' });
  }
  if (manifests.includes('build.gradle.kts')) {
    checks.push({ command: './gradlew test', source: 'build.gradle.kts' });
  } else if (manifests.includes('build.gradle')) {
    checks.push({ command: './gradlew test', source: 'build.gradle' });
  }
  const makefileText = manifestTexts.get('Makefile');
  if (makefileText !== undefined && /^test\s*:/m.test(makefileText)) {
    checks.push({ command: 'make test', source: 'Makefile' });
  }
  const justfileText = manifestTexts.get('justfile');
  if (justfileText !== undefined && /^test\s*:/m.test(justfileText)) {
    checks.push({ command: 'just test', source: 'justfile' });
  }

  const ci: string[] = [];
  const releaseWorkflows: string[] = [];
  const workflowsDir = join(rootAbs, '.github', 'workflows');
  try {
    const wfStat = lstatSync(workflowsDir);
    if (!wfStat.isSymbolicLink() && wfStat.isDirectory()) {
      const entries = readdirSync(workflowsDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;
        const rel = `.github/workflows/${entry.name}`;
        ci.push(rel);
        const wfText = readBoundedText(rel, true);
        if (
          /release|publish/i.test(entry.name) ||
          (wfText !== null && /\b(?:release|tags)\s*:/i.test(wfText))
        ) {
          releaseWorkflows.push(rel);
        }
      }
    }
  } catch {
    // No .github/workflows directory
  }

  let hasTags = false;
  if (isGitRepo) {
    const tagRun = spawnSync('git', ['-C', rootAbs, 'tag', '-l'], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (tagRun.status === 0 && typeof tagRun.stdout === 'string' && tagRun.stdout.trim() !== '') {
      hasTags = true;
    }
  }
  const release: ReleaseSummary = {
    tags: hasTags,
    workflows: releaseWorkflows,
    source:
      ci.length > 0 && isGitRepo
        ? 'git tag + .github/workflows'
        : isGitRepo
          ? 'git tag'
          : ci.length > 0
            ? '.github/workflows'
            : 'none',
  };

  // 5. Git pace (28-day window) and co-change topology
  let commitsInWindow = 0;
  const activeHourBuckets = new Set<number>();
  const fileCoChangeAreas = new Map<string, Set<string>>();
  const areaCommitCounts = new Map<string, number>();

  if (isGitRepo) {
    gitWalks += 1;
    const sinceEpochSec = Math.floor((now.getTime() - PACE_WINDOW_DAYS * 86_400_000) / 1000);
    const logRun = spawnSync(
      'git',
      [
        '-C',
        rootAbs,
        'log',
        `--since=@${sinceEpochSec}`,
        '--format=__COMMIT__%ct',
        '--name-only',
      ],
      {
        encoding: 'utf8',
        timeout: Math.min(2_500, maxDurationMs),
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (logRun.status === 0 && typeof logRun.stdout === 'string') {
      const blocks = logRun.stdout.split('__COMMIT__').filter((b) => b.trim() !== '');
      for (const block of blocks) {
        const lines = block
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const tsLine = lines[0];
        if (!tsLine) continue;
        const tsSec = Number.parseInt(tsLine, 10);
        if (!Number.isFinite(tsSec)) continue;
        commitsInWindow += 1;
        activeHourBuckets.add(Math.floor(tsSec / 3600));

        const touchedFiles = lines.slice(1);
        const commitAreas = new Set<string>();
        for (const f of touchedFiles) {
          const area = areaOfFile(f);
          if (area !== null) commitAreas.add(area);
        }
        for (const area of commitAreas) {
          areaCommitCounts.set(area, (areaCommitCounts.get(area) ?? 0) + 1);
        }
        if (commitAreas.size > 1) {
          for (const f of touchedFiles) {
            let set = fileCoChangeAreas.get(f);
            if (!set) {
              set = new Set<string>();
              fileCoChangeAreas.set(f, set);
            }
            for (const area of commitAreas) set.add(area);
          }
        }
      }
    }
  }

  const commitsPerDay = Math.round((commitsInWindow / PACE_WINDOW_DAYS) * 10) / 10;
  const rawActiveHours = Math.round((activeHourBuckets.size / PACE_WINDOW_DAYS) * 10) / 10;
  const activeHoursPerDay = commitsInWindow > 0 && rawActiveHours === 0 ? 0.1 : rawActiveHours;
  let rhythm: PaceRhythm;
  if (!isGitRepo || commitsInWindow === 0) {
    rhythm = 'sparse';
  } else if (activeHoursPerDay <= 0.5) {
    rhythm = 'idle';
  } else if (activeHoursPerDay <= 2.0) {
    rhythm = 'steady-idle';
  } else if (activeHoursPerDay <= 6.0) {
    rhythm = 'active';
  } else {
    rhythm = 'bursty';
  }

  const pace: ProjectPace = {
    window_days: PACE_WINDOW_DAYS,
    commits_per_day: commitsPerDay,
    active_hours_per_day: activeHoursPerDay,
    rhythm,
    source: !isGitRepo
      ? 'none (not a git repository)'
      : commitsInWindow === 0
        ? 'git log (sparse: 0 commits)'
        : 'git log',
  };

  // Topology: parallelizable areas vs serial shared bottlenecks
  const discoveredAreas = new Set<string>();
  for (const relPath of fileList) {
    const area = areaOfFile(relPath);
    if (area !== null) discoveredAreas.add(area);
  }
  const parallelizable = Array.from(discoveredAreas)
    .sort((a, b) => (areaCommitCounts.get(b) ?? 0) - (areaCommitCounts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 8);

  const serialSet = new Set<string>();
  for (const known of KNOWN_SERIAL_FILES) {
    if (fileList.includes(known)) serialSet.add(known);
  }
  const coChangedSorted = Array.from(fileCoChangeAreas.entries())
    .filter(([, areas]) => areas.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  for (const [file] of coChangedSorted) {
    if (serialSet.size >= 8) break;
    serialSet.add(file);
  }
  const serial = Array.from(serialSet);

  // 6. Open work from local task files (never connecting to a network broker)
  let openWork: OpenWorkSummary = { open: 0, blocked: 0, source: 'none' };
  for (const taskCandidate of ['.agents/tasks.md', '.agents/queue.yaml', '.agents/tasks.yaml']) {
    const taskFull = join(rootAbs, taskCandidate);
    try {
      const st = lstatSync(taskFull);
      if (st.isSymbolicLink() || !st.isFile()) continue;
    } catch {
      continue;
    }
    const read = readFileSource(rootAbs, { path: taskCandidate, local: true });
    if (read.kind === 'records' && read.records.length > 0) {
      let open = 0;
      let blocked = 0;
      for (const rec of read.records) {
        if (issueState(rec) === 'blocked') blocked += 1;
        else open += 1;
      }
      openWork = { open, blocked, source: taskCandidate };
      break;
    }
    const rawTasks = readBoundedText(taskCandidate, true);
    if (rawTasks !== null) {
      let open = 0;
      let blocked = 0;
      for (const line of rawTasks.split('\n')) {
        const trimmed = line.trim();
        if (/^[-*]\s+\[\s\]\s+/.test(trimmed)) {
          if (/\bblocked\b/i.test(trimmed)) blocked += 1;
          else open += 1;
        }
      }
      openWork = { open, blocked, source: taskCandidate };
      break;
    }
  }

  // 7. Visibility
  let visibility: ProjectVisibility;
  if (options.visibilityHint !== undefined) {
    visibility = { value: options.visibilityHint, source: 'registry' };
  } else if (pkgPrivate !== undefined) {
    visibility = { value: pkgPrivate ? 'private' : 'public', source: 'package.json' };
  } else if (isGitRepo) {
    const remoteRun = spawnSync('git', ['-C', rootAbs, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (remoteRun.status === 0 && typeof remoteRun.stdout === 'string' && remoteRun.stdout.trim() !== '') {
      visibility = { value: 'private', source: 'git remote' };
    } else {
      visibility = { value: 'private', source: 'local git repository' };
    }
  } else {
    visibility = { value: 'not known', source: 'none' };
  }

  const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
  const analysis_cost: AnalysisCost = {
    duration_ms: durationMs,
    git_walks: gitWalks,
    files_read: filesRead,
    bytes_read: bytesRead,
    tokens: 0,
    usd: 0,
  };

  const displayRoot = options.displayRoot ?? (relative(process.cwd(), rootAbs) || '.');

  return {
    ok: true,
    report: {
      root: displayRoot,
      visibility,
      manifests,
      size: {
        files: totalFiles,
        lines: totalLines,
        mark: estimated ? 'estimated' : 'measured',
        source: sizeSource,
      },
      languages,
      stack_skills,
      checks,
      ci,
      release,
      pace,
      open_work: openWork,
      topology: {
        parallelizable,
        serial,
      },
      findings,
    },
    analysis_cost,
  };
}
