// Synthetic out-of-process registry publisher for the drift repair race regression.
// Run through the test runtime from the repository, with no environment/PATH changes.
import { renameSync, writeFileSync } from 'node:fs';

const [file, text] = process.argv.slice(2);
if (file === undefined || text === undefined) throw new Error('synthetic record path and bytes required');
const staged = `${file}.synthetic-next`;
writeFileSync(staged, text, { flag: 'wx' });
renameSync(staged, file);
