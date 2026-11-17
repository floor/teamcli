// Review round 1, finding 1 and decision B: an auditable inventory of every call in the warm send
// host's import closure that can change something outside the process, each one passing the
// effect guard first or listed with its reason (test/host/effect-inventory.allow.ts).
import { describe, expect, test } from 'bun:test';
import { inventory } from './effect-inventory.ts';
import { DYNAMIC, FFI, NAMESPACE, PACKAGES, RAW_FS, READS } from './effect-inventory.allow.ts';

const inv = inventory();
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

describe('the hosted send path effect inventory', () => {
  test('the closure is the whole CLI the host loads, package code included', () => {
    expect(inv.files).toContain('src/commands/send.ts');
    expect(inv.files).toContain('src/commands/reply.ts');
    expect(inv.files).toContain('src/commands/ack.ts');
    expect(inv.files).toContain('packages/relay/index.js');
    expect(inv.files.length).toBeGreaterThan(500);
  });

  test('no closure module imports a file-changing fs name except through the guarded modules', () => {
    expect(sorted(inv.rawFsImports)).toEqual(sorted(Object.keys(RAW_FS)));
  });

  test('no closure module takes node:fs, node:fs/promises or node:child_process whole', () => {
    expect(sorted(inv.namespaceImports)).toEqual(sorted(Object.keys(NAMESPACE)));
  });

  test('every process, socket, network or relay call is guarded first or listed as a read', () => {
    const unguarded = sorted(inv.sites.filter((s) => !s.guarded).map((s) => `${s.key} ${s.what}`));
    const unlisted = unguarded.filter((k) => READS[k] === undefined);
    expect(unlisted).toEqual([]);
    // No stale entry: each listed read still names a site, and none of them is also guarded.
    expect(sorted(Object.keys(READS)).filter((k) => !unguarded.includes(k))).toEqual([]);
  });

  // Review round 2, finding 2: starters reached through a local alias (`const fetchFn = input.fetch
  // ?? fetch`) or an indirect callee (`(input.fetch ?? fetch)(…)`) are sites like direct calls. The
  // two webhook POSTs are named here so a collector change cannot drop them silently.
  test('the webhook POSTs, through an alias and an indirect callee, are listed and guarded', () => {
    const want = [
      'src/bus/webhook.ts#deliverWebhook fetch',
      'src/bus/webhook.ts#postArrivalWebhook fetch (indirect)',
      'src/bus/webhook.ts#finishLateWorker fetch',
    ];
    for (const key of want) {
      const found = inv.sites.filter((s) => `${s.key} ${s.what}` === key);
      expect({ key, present: found.length > 0, guarded: found.every((s) => s.guarded) }).toEqual({ key, present: true, guarded: true });
    }
  });

  test('the relay package is entered only through the guarded wrappers', () => {
    const relay = inv.sites.filter((s) => s.what.startsWith('relay.') && s.what !== 'relay.capabilities');
    for (const s of relay) expect({ site: `${s.key} ${s.what}`, guarded: s.guarded }).toEqual({ site: `${s.key} ${s.what}`, guarded: true });
  });

  test('non-literal dynamic imports and packages are each listed', () => {
    expect(sorted(inv.dynamic)).toEqual(sorted(Object.keys(DYNAMIC)));
    expect(sorted(inv.packages.keys())).toEqual(sorted(Object.keys(PACKAGES)));
  });

  test('every FFI binding in the closure is listed with what it binds', () => {
    expect(sorted(inv.ffi)).toEqual(sorted(Object.keys(FFI)));
  });

  test('the builtins the closure imports are the known set; a new one is reviewed here first', () => {
    expect(sorted(inv.builtins.keys())).toEqual([
      'bun:ffi', 'node:async_hooks', 'node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises',
      'node:http', 'node:module', 'node:net', 'node:os', 'node:path', 'node:readline', 'node:tls',
      'node:url', 'node:util',
    ]);
  });
});
