// A real process restart for late-receipt scenes: no in-memory cache crosses this boundary.
// The parent passes only its synthetic root and startup home; no default owner store is read.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createReconcileState, reconcilePassAsync } from '../src/bus/reconcile.ts';
import type { ReconcileOptions } from '../src/bus/reconcile.ts';

const input = JSON.parse(process.argv[2]!) as ReconcileOptions;
assert.equal(input.home, process.env.HOME);
assert.equal(input.home, homedir());
const state = createReconcileState();
const options = { ...input, now: new Date(input.now!), state, sliceMs: 0 };
const first = await reconcilePassAsync(options);
if (!first.ok) throw new Error(first.reason);
assert.equal(first.ok, true);
const second = await reconcilePassAsync(options);
if (!second.ok) throw new Error(second.reason);
assert.equal(second.ok, true);
console.log(JSON.stringify({ first: first.raised, second: second.raised }));
