import {
  DEFAULT_COMMIT_TEMPLATE,
  DEFAULT_FORBIDDEN,
  DEFAULT_PR_TEMPLATE,
  hasVersionToken,
  isTrailerTemplate,
  templateProblem,
} from '../signature.ts';
import type { Position, TeamFile } from '../types.ts';
import type { Check } from '../check.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Section } from './section.ts';

const POSITIONS: Position[] = ['last-line', 'trailer', 'anywhere'];

export const identity: Section = {
  name: 'identity',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return readIdentity(entry, ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      signature: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: { type: 'string' },
          commits: {
            type: 'object',
            additionalProperties: false,
            properties: {
              template: { type: 'string' },
              position: { enum: POSITIONS },
              exempt: { type: 'array', items: { const: 'merge' } },
            },
          },
          pull_requests: {
            type: 'object',
            additionalProperties: false,
            properties: {
              template: { type: 'string' },
              position: { enum: POSITIONS },
            },
          },
        },
      },
      humans: { type: 'array', items: { type: 'string', minLength: 1 } },
      since: { type: 'string' },
      forbidden: { type: 'array', items: { type: 'string' } },
      forbidden_public: { type: 'array', items: { type: 'string' } },
    },
    $comment: 'forbidden and forbidden_public are regular expressions; a template in the position "trailer" must read as a git trailer',
  },
};

export function readIdentity(entry: YamlEntry | undefined, check: Check): TeamFile['identity'] {
  const identity = check.fields(entry?.value, 'identity', ['signature', 'humans', 'since', 'forbidden', 'forbidden_public']);
  const signature = check.fields(identity.get('signature')?.value, 'identity.signature', ['template', 'commits', 'pull_requests']);
  const commits = check.fields(signature.get('commits')?.value, 'identity.signature.commits', ['template', 'position', 'exempt']);
  const prs = check.fields(signature.get('pull_requests')?.value, 'identity.signature.pull_requests', ['template', 'position', 'exempt']);

  const base = readTemplate(signature.get('template'), 'identity.signature.template', check) ?? DEFAULT_COMMIT_TEMPLATE;
  const commitTemplate = readTemplate(commits.get('template'), 'identity.signature.commits.template', check) ?? base;
  const prTemplate = readTemplate(prs.get('template'), 'identity.signature.pull_requests.template', check) ?? DEFAULT_PR_TEMPLATE;

  const commitPosition = check.oneOf(commits.get('position'), 'identity.signature.commits.position', POSITIONS) ?? 'trailer';
  const prPosition = check.oneOf(prs.get('position'), 'identity.signature.pull_requests.position', POSITIONS) ?? 'last-line';
  if (commitPosition === 'trailer' && !isTrailerTemplate(commitTemplate)) {
    const line = commits.get('position')?.line ?? commits.get('template')?.line ?? signature.get('template')?.line ?? entry?.line ?? 1;
    check.fail(line, 'position "trailer" needs a template git reads as a trailer: "<token>: <value>", the token without spaces');
  }

  const exemptEntry = commits.get('exempt');
  const exempt = exemptEntry ? check.list(exemptEntry, 'identity.signature.commits.exempt') : [{ value: 'merge', line: 0 }];
  for (const item of exempt) {
    if (item.value !== 'merge') check.fail(item.line, `exempt takes only "merge" in this version, found "${item.value}"`);
  }
  const prExempt = prs.get('exempt');
  if (prExempt) check.fail(prExempt.line, 'pull_requests has no exempt: it applies to commits only');

  const forbidden = readPatterns(identity.get('forbidden'), 'identity.forbidden', check);
  const forbiddenPublic = readPatterns(identity.get('forbidden_public'), 'identity.forbidden_public', check);

  return {
    signature: {
      commits: { template: commitTemplate, position: commitPosition, exempt: exempt.some((item) => item.value === 'merge') ? ['merge'] : [] },
      pullRequests: { template: prTemplate, position: prPosition },
    },
    humans: check.list(identity.get('humans'), 'identity.humans').map((item) => item.value),
    since: check.text(identity.get('since'), 'identity.since') ?? null,
    forbidden: [...DEFAULT_FORBIDDEN, ...forbidden.filter((pattern) => !DEFAULT_FORBIDDEN.includes(pattern))],
    forbiddenPublic,
  };
}

function readTemplate(entry: YamlEntry | undefined, name: string, check: Check): string | undefined {
  const template = check.text(entry, name);
  if (template === undefined || !entry) return undefined;
  const problem = templateProblem(template);
  if (problem) check.fail(entry.value.line, `${name}: ${problem}`);
  return template;
}

function readPatterns(entry: YamlEntry | undefined, name: string, check: Check): string[] {
  const out: string[] = [];
  for (const item of check.list(entry, name)) {
    try {
      new RegExp(item.value);
      out.push(item.value);
    } catch (error) {
      check.fail(item.line, `${name}: not a regular expression (${(error as Error).message})`);
    }
  }
  return out;
}
