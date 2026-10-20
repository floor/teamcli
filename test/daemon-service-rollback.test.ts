// Regression scenes for the service half of the OD1057 go-live path: a refused registration
// must leave no unit behind, and an uninstall whose stop command fails must refuse rather than
// report the service removed. Every platform command goes to an injected runner, so no live
// service manager runs and no unit is ever registered for real.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceProgram, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';

const homes: string[] = [];

function scratchHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-service-rollback-')));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const PROGRAM: ServiceProgram = { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] };

const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };
const FAILED: ServiceRunResult = { status: 1, stdout: '', stderr: 'refused' };

/** One answer per call, in order; the last answer repeats for any call after it. */
function scripted(answers: ServiceRunResult[]): ServiceRunner {
  let index = 0;
  return (): ServiceRunResult => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return answer ?? FAILED;
  };
}

describe('a refused registration rolls its unit back', () => {
  test('a registration the service manager refuses leaves no unit behind', () => {
    const home = scratchHome();
    const manager = darwinServiceManager({ runner: scripted([FAILED]), uid: 501 });

    const result = manager.install(home, PROGRAM);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    // The refused install is not rolled back while the unit it wrote is still there to be loaded.
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });

  test('a refusal after the unload retry leaves no unit behind either', () => {
    const home = scratchHome();
    // The first registration is refused, the unload succeeds, the retry is refused again.
    const manager = darwinServiceManager({ runner: scripted([FAILED, OK, FAILED]), uid: 501 });

    const result = manager.install(home, PROGRAM);

    expect(result.ok).toBe(false);
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });
});

describe('a stop that fails is never reported as a removal', () => {
  test('a failed stop is refused, and the unit stays for the retry', () => {
    const home = scratchHome();
    const manager = darwinServiceManager({ runner: scripted([OK]), uid: 501 });
    expect(manager.install(home, PROGRAM).ok).toBe(true);
    expect(existsSync(manager.unitPath(home))).toBe(true);

    const stopping = darwinServiceManager({ runner: scripted([FAILED]), uid: 501 });
    const result = stopping.uninstall(home);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    // The job may still be running; deleting its unit would hide the thing a retry must stop.
    expect(existsSync(stopping.unitPath(home))).toBe(true);
  });

  test('nothing installed is not a failed stop: the uninstall says so and writes nothing', () => {
    const home = scratchHome();
    const manager = darwinServiceManager({ runner: scripted([FAILED]), uid: 501 });

    const result = manager.uninstall(home);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(false);
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });
});
