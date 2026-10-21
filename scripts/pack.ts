// Produces the release or hotfix tarball with its source stamped.
//
// A tarball is evidence of what shipped, so it must name the commit it was
// built from. The 0.5.3-hotfix.25 build is the case this prevents: its version
// was edited in the working tree and never committed, so the tarball's source
// could not be recovered from the repository afterwards. This script packs
// only a clean tree whose package.json version is already committed at HEAD,
// packs from a temporary staging copy (the tracked package.json is never
// touched, so a crash cannot leave it altered), writes `gitHead` — the full
// HEAD SHA — into the staged manifest, and verifies every tarball member
// against the staged HEAD sources. A `<tarball>.stamp.json` beside the tarball
// records the artifact identity: sha256, bytes, version, gitHead, builtAt and
// branch. The source SHA is read from git, never accepted from a caller and
// never inferred.
//
// The gzip layer is pinned too: npm builds the tar, then
// `scripts/reproducible-gzip.mjs` rewrites only its gzip frame with the fixed
// compressor (Node v22.23.3, zlib 1.3.1-e00f703, level 9, stable header), so
// the same commit packs to the same compressed SHA256 on every supported
// machine. The stamp also records the uncompressed tar's SHA256 and that
// compressor identity; builtAt stays in the sidecar and never enters the
// archive, whose tar bytes are exactly npm's.
//
//   bun run pack [--pack-destination <dir>]
//
// Exit 2 when a precondition fails (no git checkout, a changed working tree,
// an uncommitted version, an unpinned compressor or tar builder, or a tarball
// that does not carry the stamp).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { COMPRESSOR, toolchainProblem } from './reproducible-gzip.mjs';

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error !== undefined) exit(`pack: cannot run git: ${result.error.message}`, 2);
  if (result.status !== 0) exit(`pack: git ${args.join(' ')} failed: ${result.stderr.trim()}`, 2);
  return result.stdout;
}

/** sha256 of one file, for comparing the archive with the staged sources. */
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The npm that builds the tar; fixed so tar headers, modes and stamps stay stable. */
const NPM_VERSION = '10.9.9';

function commandOutput(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout.trim();
}

/** Refuses anything but the pinned compressor and tar builder, naming what it found. */
function checkToolchain(): void {
  const node = commandOutput('node', ['--version']) ?? '(not found)';
  const zlib = commandOutput('node', ['-p', 'process.versions.zlib']) ?? '(not found)';
  const npm = commandOutput('npm', ['--version']) ?? '(not found)';
  const problems: string[] = [];
  const compressor = toolchainProblem({ node, zlib });
  if (compressor !== undefined) problems.push(compressor);
  if (npm !== NPM_VERSION) problems.push(`npm must be ${NPM_VERSION} for stable tar headers; this run has ${npm}`);
  if (problems.length > 0) exit(`pack: ${problems.join('; ')}`, 2);
}

/** Every regular file under `dir`, as paths relative to it. */
function files(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        found.push(relative(dir, path));
      }
    }
  };
  walk(dir);
  return found;
}

const argv = process.argv.slice(2);
let destination = '.';
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index] as string;
  if (arg === '--pack-destination') {
    const next = argv[index + 1];
    if (next === undefined || next === '') exit('pack: --pack-destination needs a directory', 2);
    destination = next;
    index += 1;
  } else if (arg.startsWith('--pack-destination=')) {
    destination = arg.slice('--pack-destination='.length);
  } else {
    exit(`pack: unknown argument ${JSON.stringify(arg)}`, 2);
  }
}

// 1. The version must already be the commit's version: a version edited in the
// working tree is exactly how .25's source was lost. This is checked before the
// clean-tree test so that shape gets the precise message.
let working: { version?: unknown };
let committed: { version?: unknown; bin?: unknown };
try {
  working = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
} catch (error) {
  exit(`pack: cannot read package.json: ${(error as Error).message}`, 2);
}
try {
  committed = JSON.parse(git(['show', 'HEAD:package.json'])) as { version?: unknown; bin?: unknown };
} catch (error) {
  exit(`pack: HEAD's package.json is not JSON: ${(error as Error).message}`, 2);
}
const version = working.version;
if (typeof version !== 'string' || version === '') {
  exit('pack: package.json has no version', 2);
}
if (committed.version !== version) {
  exit(
    `pack: package.json version ${JSON.stringify(version)} is not committed at HEAD ` +
      `(HEAD has ${JSON.stringify(committed.version ?? null)}); commit the version before packing`,
    2,
  );
}

// 2. Only a clean tree has a source commit that describes its content.
const status = git(['status', '--porcelain']);
if (status.trim() !== '') {
  exit(`pack: the working tree has changes; commit them first, then pack:\n${status.trimEnd()}`, 2);
}

const source = git(['rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/.test(source)) {
  exit(`pack: git rev-parse HEAD returned ${JSON.stringify(source)}, not a full commit SHA`, 2);
}

// 3. The compressed bytes must come from the pinned compressor and tar builder,
// or the same commit packs to different hashes on different machines. Refuse
// before building, naming the versions this run actually has.
checkToolchain();

// 4. Build from these sources, so dist/ matches the stamped commit. The build's
// stdout goes to stderr: this script's stdout is one JSON line the workflows parse.
const build = spawnSync('bun', ['run', 'build'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
if (build.error !== undefined) exit(`pack: cannot run the build: ${build.error.message}`, 2);
if (build.stdout !== null && build.stdout !== '') process.stderr.write(build.stdout);
if (build.status !== 0) process.exit(build.status ?? 1);

// The build must not have changed tracked content, or the stamp would name a
// commit the tarball's sources no longer match.
const afterBuild = git(['status', '--porcelain']);
if (afterBuild.trim() !== '') {
  exit(`pack: the build changed the working tree; commit or ignore its output before packing:\n${afterBuild.trimEnd()}`, 2);
}

// 5. Pack from a staging copy of HEAD plus the build output. The tracked
// package.json is never edited: the stamp goes into the staging manifest only.
const directory = resolve(destination);
mkdirSync(directory, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'team-pack-'));
const staging = join(work, 'stage');
const unpacked = join(work, 'unpacked');
const npmOutput = join(work, 'npm');
const archive = join(work, 'head.tar');
mkdirSync(staging, { recursive: true });
mkdirSync(unpacked, { recursive: true });
mkdirSync(npmOutput, { recursive: true });

let tarSha256 = '';
let stamp:
  | {
      tarball: string;
      version: string;
      gitHead: string;
      sha256: string;
      bytes: number;
      tarSha256: string;
      compressor: typeof COMPRESSOR;
      builtAt: string;
      branch: string;
    }
  | undefined;
let problem: string | undefined;
try {
  const archived = spawnSync('git', ['archive', '--format=tar', '--output', archive, 'HEAD'], { encoding: 'utf8' });
  if (archived.error !== undefined || archived.status !== 0) {
    problem = `pack: cannot archive HEAD: ${archived.error?.message ?? archived.stderr.trim()}`;
  } else {
    const extracted = spawnSync('tar', ['-xf', archive, '-C', staging], { encoding: 'utf8' });
    if (extracted.error !== undefined || extracted.status !== 0) {
      problem = `pack: cannot extract HEAD's archive: ${extracted.error?.message ?? extracted.stderr.trim()}`;
    }
  }
  if (problem === undefined && !existsSync(join(process.cwd(), 'dist'))) {
    problem = 'pack: the build wrote no dist/ to pack';
  }
  if (problem === undefined) {
    cpSync(join(process.cwd(), 'dist'), join(staging, 'dist'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest.gitHead = source;
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', npmOutput], {
      cwd: staging,
      encoding: 'utf8',
    });
    if (packed.error !== undefined) {
      problem = `pack: cannot run npm pack: ${packed.error.message}`;
    } else if (packed.status !== 0) {
      problem = `pack: npm pack failed: ${packed.stderr.trim()}`;
    } else {
      let name: unknown;
      try {
        name = (JSON.parse(packed.stdout) as { filename?: unknown }[])[0]?.filename;
      } catch (error) {
        problem = `pack: npm pack printed no JSON report: ${(error as Error).message}`;
      }
      if (problem === undefined && (typeof name !== 'string' || name === '')) {
        problem = 'pack: npm pack reported no filename';
      }
      if (problem === undefined) {
        const npmTarball = join(npmOutput, name as string);
        const tarball = join(directory, name as string);
        // npm's tar is kept as it is; only the gzip frame is rewritten by the
        // pinned compressor. The report names the input, tar and output hashes.
        const recompressed = spawnSync(
          'node',
          [fileURLToPath(new URL('reproducible-gzip.mjs', import.meta.url)), npmTarball, tarball],
          { encoding: 'utf8' },
        );
        let report: { tar?: { sha256?: unknown }; output?: { sha256?: unknown } } | undefined;
        if (recompressed.error !== undefined) {
          problem = `pack: cannot run the pinned compressor: ${recompressed.error.message}`;
        } else if (recompressed.status !== 0) {
          problem = `pack: the pinned compressor failed: ${recompressed.stderr.trim()}`;
        } else {
          try {
            report = JSON.parse(recompressed.stdout) as typeof report;
          } catch (error) {
            problem = `pack: the pinned compressor printed no JSON report: ${(error as Error).message}`;
          }
        }
        if (problem === undefined) {
          try {
            const npmTar = gunzipSync(readFileSync(npmTarball));
            const finalBytes = readFileSync(tarball);
            const finalTar = gunzipSync(finalBytes);
            if (!npmTar.equals(finalTar)) {
              problem = 'pack: the pinned compressor changed the tar bytes';
            } else if (finalBytes.subarray(0, 10).toString('hex') !== COMPRESSOR.gzipHeader) {
              problem = `pack: the tarball header is ${finalBytes.subarray(0, 10).toString('hex')}, not ${COMPRESSOR.gzipHeader}`;
            } else {
              tarSha256 = createHash('sha256').update(finalTar).digest('hex');
              if (report?.tar?.sha256 !== tarSha256) {
                problem = 'pack: the pinned compressor reported a different tar sha256';
              } else if (report?.output?.sha256 !== createHash('sha256').update(finalBytes).digest('hex')) {
                problem = 'pack: the pinned compressor reported a different output sha256';
              }
            }
          } catch (error) {
            problem = `pack: cannot verify the pinned compressor output: ${(error as Error).message}`;
          }
        }
        if (problem === undefined) {
          // 6. Verify the artifact itself: the manifest names this commit, and
          // every member is the staged source byte for byte.
          const read = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
          if (read.error !== undefined || read.status !== 0) {
            problem = `pack: cannot read package/package.json from ${tarball}`;
          } else {
            const packedManifest = JSON.parse(read.stdout) as { version?: unknown; gitHead?: unknown; bin?: unknown };
            if (packedManifest.version !== version || packedManifest.gitHead !== source) {
              problem =
                `pack: the tarball carries version ${JSON.stringify(packedManifest.version ?? null)} and ` +
                `gitHead ${JSON.stringify(packedManifest.gitHead ?? null)}; expected ${JSON.stringify(version)} and ${JSON.stringify(source)}`;
            }
            const bin = (packedManifest.bin as { team?: unknown } | undefined)?.team;
            if (problem === undefined) {
              const again = spawnSync('tar', ['-xzf', tarball, '-C', unpacked], { encoding: 'utf8' });
              if (again.error !== undefined || again.status !== 0) {
                problem = `pack: cannot unpack ${tarball} for verification`;
              } else if (typeof bin === 'string' && bin !== '' && !existsSync(join(unpacked, 'package', bin))) {
                problem = `pack: the tarball does not carry the bin ${JSON.stringify(bin)}`;
              }
            }
            if (problem === undefined) {
              for (const path of files(join(unpacked, 'package'))) {
                if (path === 'package.json') continue;
                const staged = join(staging, path);
                if (!existsSync(staged) || digest(staged) !== digest(join(unpacked, 'package', path))) {
                  problem = `pack: the tarball member ${JSON.stringify(path)} is not the staged HEAD source`;
                  break;
                }
              }
            }
            if (problem === undefined) {
              const bytes = statSync(tarball).size;
              stamp = {
                tarball: name as string,
                version,
                gitHead: source,
                sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
                bytes,
                tarSha256,
                compressor: COMPRESSOR,
                builtAt: new Date().toISOString(),
                branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
              };
              writeFileSync(`${tarball}.stamp.json`, `${JSON.stringify(stamp, null, 2)}\n`);
            }
          }
        }
      }
    }
  }
} catch (error) {
  problem = `pack: ${(error as Error).message}`;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problem !== undefined) exit(problem, 2);
if (stamp === undefined) exit('pack: no stamp was produced', 2);
console.log(JSON.stringify(stamp));
