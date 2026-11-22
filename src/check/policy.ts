// Public checking needs identity rules and signer history, not a runnable team.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Check } from '../file/check.ts';
import { readIdentity } from '../file/sections/identity.ts';
import { hasVersionToken } from '../file/signature.ts';
import type { Problem } from '../file/types.ts';
import { parseYaml, YamlError, type YamlNode } from '../yaml.ts';
import { mergeLedger } from '../store/store.ts';
import type { CheckConfig, SeatIdentity } from './config.ts';

export const POLICY_KIND = 'check-policy';
export const POLICY_FILE = '.github/policy.yaml';

type PolicyResult =
  | { ok: true; config: CheckConfig; project: string; root: string; warnings: Problem[] }
  | { ok: false; errors: Problem[]; path: string };

/** Null means an explicitly named legacy team document, handled by its existing reader.
 * A policy marker or conventional policy filename always takes this dedicated validator,
 * including malformed documents: a broken policy never falls back to team defaults. */
export function readPolicyFile(cwd: string, file: string): PolicyResult | null {
  const path = resolve(cwd, file);
  const conventional = basename(path) === 'policy.yaml';
  let node: YamlNode;
  try {
    node = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    if (!conventional) return null;
    return { ok: false, path, errors: [{
      line: error instanceof YamlError ? error.line : 0,
      message: error instanceof YamlError ? error.message : `the policy file at ${path} could not be read`,
    }] };
  }
  const marked = node.kind === 'map' && node.entries.some((entry) => entry.key === 'kind');
  if (!conventional && !marked) return null;

  const check = new Check();
  if (node.kind !== 'map') check.fail(node.line, 'policy must be a map of fields');
  const top = check.fields(node, 'policy', ['kind', 'project', 'visibility', 'identity', 'signers']);
  if (check.required(top.get('kind'), 'kind', node.line) !== POLICY_KIND) {
    check.fail(top.get('kind')?.line ?? node.line, `kind must be ${POLICY_KIND}`);
  }
  const project = check.required(top.get('project'), 'project', node.line);
  const visibility = check.oneOf(top.get('visibility'), 'visibility', ['public', 'private']);
  if (!top.has('visibility')) check.fail(node.line, 'visibility is required');
  if (!top.has('identity')) check.fail(node.line, 'identity is required');
  // Only the identity section's pure field validation is shared. No TeamFile is built or
  // validated, and no workspace, launch command, trust, registry or owner setting is needed.
  const identity = readIdentity(top.get('identity'), check);
  const signers: SeatIdentity[] = [];
  const entries = top.get('signers')?.value;
  if (entries?.kind !== 'seq' || entries.items.length === 0) {
    check.fail(entries?.line ?? node.line, 'signers must be a nonempty list');
  } else {
    for (const item of entries.items) {
      if (item.kind !== 'map') check.fail(item.line, 'each signer must be a map of fields');
      const fields = check.fields(item, 'signer', ['display', 'role', 'model', 'version']);
      const display = check.required(fields.get('display'), 'signer.display', item.line);
      const role = check.required(fields.get('role'), 'signer.role', item.line);
      const model = check.required(fields.get('model'), 'signer.model', item.line);
      const version = check.required(fields.get('version'), 'signer.version', item.line);
      if (display && version && !hasVersionToken(display, version)) {
        check.fail(fields.get('display')!.line, 'signer.display must contain its version as a token');
      }
      if (display && role && model && version) signers.push({ display, role, model, version });
    }
  }
  if (check.problems.length || project === undefined) return { ok: false, path, errors: check.problems };
  // Preserve the explicit-file store root used before this policy split: the containing folder.
  // This keeps the same local ledger lookup and project-based fallback in loadConfig.
  return { ok: true, project, root: dirname(path), warnings: [], config: {
    public: visibility === 'public',
    commits: {
      template: identity.signature.commits.template,
      position: identity.signature.commits.position,
      exemptMerge: identity.signature.commits.exempt.includes('merge'),
    },
    pullRequests: identity.signature.pullRequests,
    humans: identity.humans,
    since: identity.since ?? undefined,
    forbidden: identity.forbidden,
    forbiddenPublic: identity.forbiddenPublic,
    ledger: mergeLedger([], signers),
  } };
}
