// Creates one folder below a store from its own process for the ladder-race coverage test.
// Usage: bun test/store-ladder-folder-race-run.ts <storeDir> <folder> <startAtEpochMs>
import { ensureFoldersBelow } from '../src/send/history.ts';

const [storeDir = '', folder = '', startAtRaw = '0'] = process.argv.slice(2);
const startAt = Number(startAtRaw);
while (Date.now() < startAt) await Bun.sleep(1);
const reason = ensureFoldersBelow(storeDir, [folder]);
console.log(JSON.stringify(reason === null ? { ok: true } : { ok: false, reason }));
process.exit(reason === null ? 0 : 1);
