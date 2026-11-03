// The Actions allowlist is a policy, not a seat. The release default is Floor's three commands.
// A caller may set a subset. The guard allows exactly those and refuses every other Actions command.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineRunsGh, refusedByGuard } from '../src/launch/command-guard.ts';
import { ACTIONS_COMMANDS_DEFAULT, getPolicySpec, type ActionsCommand } from '../src/policy/types.ts';

const spec = getPolicySpec('actions-commands');

test('the policy defaults to the three commands and a caller may only narrow them', () => {
  expect(spec).not.toBeNull();
  expect(spec?.defaultValue).toEqual(['rerun-failed', 'deploy', 'ci-pr-head']);
  expect(spec?.levels).toEqual(['entity', 'project', 'team', 'seat']);
  expect(spec?.parseValue('rerun-failed, deploy')).toEqual(['rerun-failed', 'deploy']);
  expect(spec?.parseValue(['ci-pr-head'])).toEqual(['ci-pr-head']);
  expect(spec?.parseValue('')).toEqual([]);
  expect(spec?.parseValue('rerun-failed, publish')).toBeNull();
  expect(spec?.parseValue('deploy, deploy')).toBeNull();
  expect(spec?.isWithin(['rerun-failed'], ACTIONS_COMMANDS_DEFAULT)).toBe(true);
  expect(spec?.isWithin([], ['rerun-failed'])).toBe(true);
  expect(spec?.isWithin(ACTIONS_COMMANDS_DEFAULT, ['deploy'])).toBe(false);
});

const none: readonly ActionsCommand[] = [];

test('the default allowlist permits the three commands and nothing else on Actions', () => {
  expect(refusedByGuard('gh run rerun --failed')).toBeNull();
  expect(refusedByGuard('gh run rerun --failed 12345')).toBeNull();
  expect(refusedByGuard('gh -R floor/teamcli run rerun --failed')).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml')).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml -f target=site')).toBeNull();
  expect(refusedByGuard('gh workflow run ci.yml --ref abc123')).toBeNull();
  expect(refusedByGuard('gh workflow run ci --ref=abc123')).toBeNull();
  expect(refusedByGuard('gh pr view 1')).toBeNull();
  expect(refusedByGuard('gh api user')).toBeNull();

  expect(refusedByGuard('gh run rerun 12345')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run list')).toBeNull();
  expect(refusedByGuard('gh run cancel 12345')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run release.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run ci.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow enable ci.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/runs/1')).toBeNull();
  expect(refusedByGuard('gh api -X POST repos/floor/teamcli/actions/runs')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api -X POST repos/floor/teamcli/dispatches')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api -X POST repos/floor/teamcli/deployments')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api --method=PATCH repos/acme/demo')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api -XPUT repos/acme/demo')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api --method DELETE repos/acme/demo')?.rule).toBe('github-comment-delete');
  expect(refusedByGuard('gh api repos/acme/demo/deployments')).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/releases -f tag_name=v0.6.1')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/floor/teamcli/releases --field tag_name=v0.6.1')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/floor/teamcli/releases -f tag_name=v0.6.1 --method GET')).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/releases -X GET -f tag_name=v0.6.1')).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/releases --method GET -X POST -f tag_name=v0.6.1')?.rule).toBe('github-actions');
  expect(refusedByGuard("gh api graphql -f query='query { viewer { login } }' -fquery='mutation { hidden }'")?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo --input body.json')?.rule).toBe('github-actions');
  expect(refusedByGuard("gh api https://api.github.com/graphql -f query='mutation { anythingElse }'")?.rule).toBe('github-actions');
  expect(refusedByGuard("gh api /graphql -f query='query { viewer { login } }'")).toBeNull();
  expect(refusedByGuard("gh api graphql -f query='mutation { anythingElse }'")?.rule).toBe('github-actions');
  expect(refusedByGuard("gh api graphql -f query='MUTATION { anythingElse }'")?.rule).toBe('github-actions');
  expect(refusedByGuard("gh api graphql -f query='query { viewer { login } }'")).toBeNull();
  expect(refusedByGuard('gh run cancel 12345')?.guidance).toBe(
    'refused in team seats: the actions-commands policy does not allow that Actions command',
  );
});

test('Actions reads are allowed, including a GET under /actions', () => {
  expect(refusedByGuard('gh run list')).toBeNull();
  expect(refusedByGuard('gh run list --commit abc123')).toBeNull();
  expect(refusedByGuard('gh run view 12345')).toBeNull();
  expect(refusedByGuard('gh run watch 12345')).toBeNull();
  expect(refusedByGuard('gh pr checks')).toBeNull();
  expect(refusedByGuard('gh workflow list')).toBeNull();
  expect(refusedByGuard('gh workflow view deploy.yml')).toBeNull();
  expect(refusedByGuard('gh api actions/runs')).toBeNull();
  expect(refusedByGuard('gh api actions/runs/12345')).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/runs')).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/runs/12345')).toBeNull();
  expect(refusedByGuard("gh api graphql -f query='query { viewer { login } }'")).toBeNull();
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/runs -f name=x')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/workflows/ci.yml/dispatches')?.rule).toBe('github-actions');
});

test('a caller that drops a command removes only that command', () => {
  const rerun: readonly ActionsCommand[] = ['rerun-failed'];
  expect(refusedByGuard('gh run rerun --failed', rerun)).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml', rerun)?.rule).toBe('github-actions');
  expect(refusedByGuard('"gh" workflow run deploy.yml', rerun)?.rule).toBe('github-actions');
  expect(refusedByGuard('\\gh workflow run deploy.yml', rerun)?.rule).toBe('github-actions');
  expect(lineRunsGh('"gh" workflow run deploy.yml')).toBe(true);
  expect(lineRunsGh('\\gh workflow run deploy.yml')).toBe(true);
  expect(lineRunsGh('echo the letters gh')).toBe(false);
  expect(refusedByGuard('gh workflow run ci.yml --ref abc', rerun)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run rerun --failed', none)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run deploy.yml', none)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh pr view 1', none)).toBeNull();
});

test('a graphql query in a file is read, and a mutation there is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gql-fixture-'));
  try {
    const query = join(dir, 'query.graphql');
    const mutation = join(dir, 'mutation.graphql');
    const body = join(dir, 'body.json');
    writeFileSync(query, 'query { viewer { login } }\n');
    writeFileSync(mutation, 'mutation { anythingElse }\n');
    writeFileSync(body, '{"query":"mutation { anythingElse }"}\n');
    expect(refusedByGuard(`gh api graphql -f query=@${query}`)).toBeNull();
    expect(refusedByGuard(`gh api graphql -f query=@${mutation}`)?.rule).toBe('github-actions');
    expect(refusedByGuard(`gh api graphql --input ${body}`)?.rule).toBe('github-actions');
    expect(refusedByGuard(`gh api graphql -f query=@${join(dir, 'missing.graphql')}`)?.rule).toBe('github-actions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('independent adversarial checks: all Actions reads pass (even under empty policy) and all write variants are refused', () => {
  // 1. Every listed read is allowed both under default policy and when `actions-commands` is empty (`none`).
  const allowedReads = [
    'gh run list',
    'gh run list --commit abc123 --branch main --limit 20',
    'gh -R acme/demo run list',
    'gh run view 12345',
    'gh run view 12345 --log --job 67890',
    'gh run watch 12345',
    'gh run watch 12345 --exit-status -i 5',
    'gh workflow list',
    'gh workflow list --all -L 10',
    'gh workflow view deploy.yml',
    'gh workflow view ci.yml --yaml',
    'gh pr checks',
    'gh pr checks 42 --watch',
    'gh api actions/runs',
    'gh api actions/runs/12345',
    'gh api repos/acme/demo/actions/runs',
    'gh api repos/acme/demo/actions/runs/12345/jobs',
    'gh api repos/acme/demo/actions/workflows/ci.yml/runs',
    'gh api -X GET repos/acme/demo/actions/runs -f branch=main -F per_page=10',
    'gh api --method=GET repos/acme/demo/actions/runs --field status=completed',
    'gh api -Xget repos/acme/demo/actions/runs -fbranch=main',
    "gh api graphql -f query='query { repository(owner: \"acme\", name: \"demo\") { name } }'",
    '"gh" run view 12345',
    "'gh' workflow list",
    '\\gh api repos/acme/demo/actions/runs/12345',
  ];
  for (const cmd of allowedReads) {
    expect(refusedByGuard(cmd), `default: ${cmd}`).toBeNull();
    expect(refusedByGuard(cmd, none), `none: ${cmd}`).toBeNull();
  }

  // 2. Every write variant is refused (run cancel/delete/download, workflow enable/disable/run,
  //    rerun without --failed, api explicit/implicit writes, /dispatches on any verb, graphql
  //    mutations, and quoted/backslash/prefixed gh invocations).
  const refusedWrites = [
    // run writes & non-read subcommands
    'gh run cancel 12345',
    'gh -R acme/demo run cancel 12345',
    'gh run delete 12345',
    'gh run download 12345',
    'gh run',
    // rerun without --failed or with non-numeric positional
    'gh run rerun',
    'gh run rerun 12345',
    'gh run rerun 12345 --debug',
    'gh run rerun --failed 12345 extra-word',
    // workflow writes & non-read subcommands
    'gh workflow enable ci.yml',
    'gh workflow disable ci.yml',
    'gh workflow disable deploy.yml',
    'gh workflow run release.yml',
    'gh workflow run ci.yml',
    'gh workflow run ci.yml --ref=',
    'gh workflow run deploy.yml extra-arg',
    'gh workflow',
    // api explicit write methods on /actions (and lowercase / glued / --method= forms)
    'gh api -X POST repos/acme/demo/actions/runs/12345/cancel',
    'gh api -XPOST repos/acme/demo/actions/runs/12345/rerun',
    'gh api -X post repos/acme/demo/actions/runs/12345/rerun-failed-jobs',
    'gh api --method POST repos/acme/demo/actions/workflows/ci.yml/dispatches',
    'gh api --method=PUT repos/acme/demo/actions/workflows/ci.yml/enable',
    'gh api -XPUT repos/acme/demo/actions/workflows/ci.yml/disable',
    'gh api --method=PATCH repos/acme/demo/actions/variables/CI_MODE',
    'gh api -X GET -X POST repos/acme/demo/actions/runs/12345/cancel',
    // api implicit POSTs (parameters or --input without explicit GET)
    'gh api repos/acme/demo/actions/runs -f branch=main',
    'gh api repos/acme/demo/actions/runs --field branch=main',
    'gh api repos/acme/demo/actions/runs --field=branch=main',
    'gh api repos/acme/demo/actions/runs -f=branch=main',
    'gh api repos/acme/demo/actions/runs -fbranch=main',
    'gh api repos/acme/demo/actions/runs -F per_page=10',
    'gh api repos/acme/demo/actions/runs --raw-field per_page=10',
    'gh api repos/acme/demo/actions/runs --raw-field=per_page=10',
    'gh api repos/acme/demo/actions/runs -F=per_page=10',
    'gh api repos/acme/demo/actions/runs -Fper_page=10',
    'gh api repos/acme/demo/actions/runs --input payload.json',
    'gh api repos/acme/demo/actions/runs --input=payload.json',
    // /dispatches refused on every verb, even explicit GET
    'gh api repos/acme/demo/dispatches',
    'gh api -X GET repos/acme/demo/dispatches',
    'gh api --method=GET repos/acme/demo/actions/workflows/ci.yml/dispatches',
    'gh api actions/workflows/deploy.yml/dispatches',
    // graphql mutations & missing queries
    'gh api graphql',
    "gh api graphql -f query='mutation { cancelWorkflowRun(input: {id: \"1\"}) { clientMutationId } }'",
    "gh api /graphql -F query='MUTATION { deleteWorkflowRun(input: {id: \"1\"}) { clientMutationId } }'",
    "gh api https://api.github.com/graphql --field=query='mutation { rerunWorkflow }'",
    "gh api graphql -fquery='mutation { rerunWorkflow }'",
    // quoted, backslash-escaped, path-qualified, and wrapper-prefixed gh invocations
    '"gh" run cancel 12345',
    "'gh' run delete 12345",
    '\\gh workflow disable ci.yml',
    '\\gh workflow enable ci.yml',
    '"gh" run rerun 12345',
    '\\gh api repos/acme/demo/actions/runs -f name=x',
    '"gh" api -X GET repos/acme/demo/actions/workflows/ci.yml/dispatches',
    "\\gh api graphql -f query='mutation { x }'",
    '/usr/local/bin/gh run cancel 12345',
    'env gh workflow disable ci.yml',
    'command gh run delete 12345',
    'echo 12345 | xargs gh run cancel',
  ];
  for (const cmd of refusedWrites) {
    expect(refusedByGuard(cmd)?.rule, cmd).toBe('github-actions');
  }
  expect(lineRunsGh('"gh" run cancel 12345')).toBe(true);
  expect(lineRunsGh("'gh' workflow disable ci.yml")).toBe(true);
  expect(lineRunsGh('\\gh run delete 12345')).toBe(true);
});

const SUPERSEDE = 'refused in team seats: post a superseding comment instead';

function expectSupersede(line: string): void {
  const match = refusedByGuard(line);
  expect(match?.rule, line).toBe('github-comment-delete');
  expect(match?.guidance, line).toBe(SUPERSEDE);
}

test('gh api -X DELETE is refused on any path', () => {
  expectSupersede('gh api -X DELETE repos/acme/demo');
  expectSupersede('gh api -X DELETE repos/acme/demo/issues/comments/1');
  expectSupersede('gh api -X delete repos/acme/demo/actions/runs/12345');
  expect(refusedByGuard('gh api -X DELETE -X POST repos/acme/demo')?.rule).toBe('github-actions');
});

test('gh api --method DELETE is refused on any path', () => {
  expectSupersede('gh api --method DELETE repos/acme/demo');
  expectSupersede('gh api --method=DELETE repos/acme/demo/pulls/comments/2');
  expectSupersede('gh api --method DELETE repos/acme/demo/actions/caches/1');
});

test('gh api -XDELETE is refused on any path', () => {
  expectSupersede('gh api -XDELETE repos/acme/demo');
  expectSupersede('gh api -Xdelete repos/acme/demo/actions/runs/12345/logs');
});

test('a quoted gh refuses deleting a comment', () => {
  expectSupersede('"gh" api -X DELETE repos/acme/demo');
  expectSupersede("'gh' pr comment --delete-last");
});

test('a backslash-escaped gh refuses deleting a comment', () => {
  expectSupersede('\\gh api --method DELETE repos/acme/demo');
  expectSupersede('\\gh issue comment --delete-last');
});

test('a prefixed gh refuses deleting a comment', () => {
  expectSupersede('command gh api -XDELETE repos/acme/demo');
  expectSupersede('env gh pr comment 9 --delete-last');
  expectSupersede('/usr/local/bin/gh pr review --dismiss');
});

test('gh pr comment --delete-last is refused', () => {
  expectSupersede('gh pr comment --delete-last');
  expectSupersede('gh pr comment 42 --delete-last');
  expectSupersede('gh -R acme/demo pr comment --delete-last=true --body replaced');
});

test('gh issue comment --delete-last is refused', () => {
  expectSupersede('gh issue comment --delete-last');
  expectSupersede('gh issue comment 12 --delete-last');
});

test('gh pr review --dismiss is refused', () => {
  expectSupersede('gh pr review --dismiss');
  expectSupersede('gh pr review 7 --dismiss');
});

test('gh pr comment --body is allowed', () => {
  expect(refusedByGuard("gh pr comment --body 'the note stays'")).toBeNull();
  expect(refusedByGuard("gh issue comment 12 --body 'the note stays'")).toBeNull();
  expect(refusedByGuard("gh pr comment --body 'do not --delete-last'")).toBeNull();
});

test('gh pr comment --edit-last is allowed', () => {
  expect(refusedByGuard("gh pr comment --edit-last --body 'replaced'")).toBeNull();
  expect(refusedByGuard('gh issue comment --edit-last')).toBeNull();
  expect(refusedByGuard('gh pr review --approve')).toBeNull();
});

test('gh api -X VERB reads the next word in any case', () => {
  expectSupersede('gh api -X DeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api -X PuT repos/acme/demo')?.rule).toBe('github-actions');
});

test('gh api -X=VERB is the shorthand equals form', () => {
  expectSupersede('gh api -X=DeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api -X=PuT repos/acme/demo')?.rule).toBe('github-actions');
});

test('gh api -XVERB is the glued form in any case', () => {
  expectSupersede('gh api -XDeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api -XPuT repos/acme/demo')?.rule).toBe('github-actions');
});

test('gh api --method VERB reads the next word in any case', () => {
  expectSupersede('gh api --method DeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api --method PuT repos/acme/demo')?.rule).toBe('github-actions');
});

test('gh api --method=VERB is the long equals form in any case', () => {
  expectSupersede('gh api --method=DeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api --method=PuT repos/acme/demo')?.rule).toBe('github-actions');
});

test('the last gh api verb wins', () => {
  expectSupersede('gh api -X GET -X=DeLeTe repos/acme/demo');
  expect(refusedByGuard('gh api -X=DELETE --method=GET repos/acme/demo')).toBeNull();
  expect(refusedByGuard('gh api --method GET -X=PUT repos/acme/demo')?.rule).toBe('github-actions');
});

test('a field or --input with no explicit GET is POST', () => {
  expect(refusedByGuard('gh api repos/acme/demo -f name=x')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo -F name=x')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo --field name=x')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo --raw-field name=x')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo --input body.json')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/acme/demo -X GET -f name=x')).toBeNull();
});

test('independent adversarial matrix: five gh api verb spellings, last-wins transitions, implied POST forms, comment delete/dismiss, and allowed neighbours', () => {
  // 1. All five explicit verb spellings (-X V, -X=V, -XV, --method V, --method=V) in mixed case:
  //    DELETE -> github-comment-delete ('refused in team seats: post a superseding comment instead')
  //    POST / PUT / PATCH -> github-actions
  //    GET -> null (allowed)
  const deleteSpellings = [
    'gh api -X delete repos/acme/demo/issues/comments/101',
    'gh api -X=DeLeTe repos/acme/demo/pulls/comments/202',
    'gh api -XdElEtE repos/acme/demo/commit_comments/303',
    'gh api --method dElEtE repos/acme/demo/issues/comments/404',
    'gh api --method=DELETE repos/acme/demo/releases/assets/505',
    'gh -R acme/demo --hostname github.example.com api -X=delete repos/acme/demo/issues/comments/101',
    '"gh" api -X=DELETE repos/acme/demo/issues/comments/101',
    "'gh' api -Xdelete repos/acme/demo/issues/comments/101",
    '\\gh api --method=delete repos/acme/demo/issues/comments/101',
    'command gh api -X=DELETE repos/acme/demo/issues/comments/101',
    'env GH_HOST=github.com gh api -X=DELETE repos/acme/demo/issues/comments/101',
    '/opt/homebrew/bin/gh api -X=DELETE repos/acme/demo/issues/comments/101',
    'echo 101 | xargs gh api -X=DELETE repos/acme/demo/issues/comments/101',
    'find . -maxdepth 0 -exec gh api -X=DELETE repos/acme/demo/issues/comments/101 \\;',
    'env -S "gh api -X=DELETE repos/acme/demo/issues/comments/101"',
    'echo ok && gh api -X=DELETE repos/acme/demo/issues/comments/101',
  ];
  for (const cmd of deleteSpellings) {
    expectSupersede(cmd);
  }

  for (const verb of ['PoSt', 'pUt', 'PaTcH']) {
    for (const flag of [`-X ${verb}`, `-X=${verb}`, `-X${verb}`, `--method ${verb}`, `--method=${verb}`]) {
      const cmd = `gh api ${flag} repos/acme/demo/issues/comments/101`;
      expect(refusedByGuard(cmd)?.rule, cmd).toBe('github-actions');
    }
  }

  for (const flag of ['-X gEt', '-X=GeT', '-XgEt', '--method GeT', '--method=gEt']) {
    const cmd = `gh api ${flag} repos/acme/demo/issues/comments/101`;
    expect(refusedByGuard(cmd), cmd).toBeNull();
  }

  // 2. Last explicit verb wins across all five spellings and across fields/--input:
  //    ending in DELETE -> github-comment-delete
  expectSupersede('gh api -X GET --method=POST -XPUT --method PATCH -X=dElEtE repos/acme/demo');
  expectSupersede('gh api --method=GET -Xpost -X=DELETE -f body=note repos/acme/demo/issues/comments/1');
  expectSupersede('gh api -f body=note --input payload.json --method delete repos/acme/demo/issues/comments/1');

  //    ending in POST / PUT / PATCH after DELETE or GET -> github-actions
  expect(refusedByGuard('gh api -X=DELETE --method=pOsT repos/acme/demo')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api --method DELETE -XpUt repos/acme/demo')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api -XDELETE -X=pAtCh repos/acme/demo')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api -X=GET --method=PUT -f q=1 repos/acme/demo')?.rule).toBe('github-actions');

  //    ending in GET after DELETE or write verbs (even with -f/-F/--field/--raw-field/--input) -> allowed
  expect(refusedByGuard('gh api -X=DELETE -X gEt repos/acme/demo')).toBeNull();
  expect(refusedByGuard('gh api --method DELETE -X=GeT repos/acme/demo')).toBeNull();
  expect(refusedByGuard('gh api -XDELETE -Xget repos/acme/demo')).toBeNull();
  expect(refusedByGuard('gh api -X=POST --method get -f per_page=10 -F page=1 repos/acme/demo')).toBeNull();
  expect(refusedByGuard('gh api -X=DELETE --method=GET --field state=open --raw-field sort=created --input body.json repos/acme/demo')).toBeNull();

  // 3. Implied POST from every field / --input spelling when no explicit verb is present:
  const impliedPostCmds = [
    'gh api repos/acme/demo/issues/1/comments -f body=hi',
    'gh api repos/acme/demo/issues/1/comments -fbody=hi',
    'gh api repos/acme/demo/issues/1/comments -f=body=hi',
    'gh api repos/acme/demo/issues/1/comments -F body=hi',
    'gh api repos/acme/demo/issues/1/comments -Fbody=hi',
    'gh api repos/acme/demo/issues/1/comments -F=body=hi',
    'gh api repos/acme/demo/issues/1/comments --field body=hi',
    'gh api repos/acme/demo/issues/1/comments --field=body=hi',
    'gh api repos/acme/demo/issues/1/comments --raw-field body=hi',
    'gh api repos/acme/demo/issues/1/comments --raw-field=body=hi',
    'gh api repos/acme/demo/issues/1/comments --input comment.json',
    'gh api repos/acme/demo/issues/1/comments --input=comment.json',
  ];
  for (const cmd of impliedPostCmds) {
    expect(refusedByGuard(cmd)?.rule, cmd).toBe('github-actions');
  }

  //    And explicit GET in all 5 spellings overrides the implied POST from fields/--input:
  for (const getFlag of ['-X get', '-X=get', '-Xget', '--method get', '--method=get']) {
    const cmd = `gh api ${getFlag} repos/acme/demo/issues/1/comments -f per_page=5 -F page=1 --field sort=created --raw-field direction=desc --input params.json`;
    expect(refusedByGuard(cmd), cmd).toBeNull();
  }

  // 4. Comment delete and review dismiss variations (all refused with github-comment-delete & supersede guidance):
  const commentDeleteAndDismiss = [
    'gh pr comment --delete-last',
    'gh pr comment 17 --delete-last',
    'gh pr comment 17 --delete-last=true',
    'gh pr comment 17 --delete-last=1',
    'gh -R acme/demo pr comment 17 --delete-last',
    'gh --repo=acme/demo pr comment 17 --delete-last=true',
    'gh issue comment --delete-last',
    'gh issue comment 23 --delete-last',
    'gh issue comment 23 --delete-last=true',
    'gh -R acme/demo issue comment 23 --delete-last',
    'gh pr review --dismiss',
    'gh pr review 31 --dismiss',
    'gh pr review 31 --dismiss=true -b "obsolete"',
    'gh --repo acme/demo pr review 31 --dismiss',
    'command gh pr review 31 --dismiss',
    'env gh issue comment 23 --delete-last',
  ];
  for (const cmd of commentDeleteAndDismiss) {
    expectSupersede(cmd);
  }

  // 5. Allowed neighbours (adding/editing comments, non-dismiss reviews, GraphQL reads, and quoted arguments):
  const allowedNeighbours = [
    'gh pr comment 17 --body "superseding comment with updated findings"',
    'gh pr comment 17 --edit-last --body "amended findings"',
    'gh issue comment 23 --body "superseding issue note"',
    'gh issue comment 23 --edit-last --body "amended issue note"',
    'gh pr review 31 --comment --body "review note"',
    'gh pr review 31 --approve --body "looks good"',
    'gh pr review 31 --request-changes --body "please add test"',
    'gh api repos/acme/demo/issues/comments/101',
    'gh api repos/acme/demo/pulls/17/comments',
    'gh api graphql -f query="query { viewer { login } }"',
    'team send worker "do not run gh pr comment --delete-last or gh api -X=DELETE repos/acme/demo"',
    'echo "gh pr review --dismiss && gh api -X=DELETE repos/acme/demo"',
  ];
  for (const cmd of allowedNeighbours) {
    expect(refusedByGuard(cmd), cmd).toBeNull();
  }
});

