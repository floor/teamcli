#!/usr/bin/env node
// TEST ONLY. A stand-in for helpers/owner-seat-keystore with the same command line, holding
// software P-256 keys in keys/ next to itself. It refuses to run outside /private/tmp or /tmp, and
// it writes each "prompt" the real helper would show (Touch ID) to prompts.log, so a dry run can
// list the dialogs the owner will see. Never install it in a real home.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(realpathSync(process.argv[1]));
if (!/^\/(private\/)?tmp\//.test(here)) { process.stderr.write('fake keystore: test homes only\n'); process.exit(1); }
const keys = join(here, 'keys');
const [command, label, reason] = process.argv.slice(2);
const fail = (m) => { process.stderr.write(`${m}\n`); process.exit(1); };
const point = (key) => { const j = key.export({ format: 'jwk' }); return `04${Buffer.from(j.x, 'base64url').toString('hex')}${Buffer.from(j.y, 'base64url').toString('hex')}`; };
const stdin = () => readFileSync(0, 'utf8').trim();
const file = (kind) => join(keys, `${label}.${kind}`);
if (command === 'selftest') { console.log('ok fake-keystore (TEST ONLY)'); process.exit(0); }
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) fail('bad label');
mkdirSync(keys, { recursive: true, mode: 0o700 });
switch (command) {
  case 'create': {
    if (existsSync(file('pem'))) fail(`a key named ${label} already exists`);
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(file('pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(point(pair.publicKey));
    break;
  }
  case 'public': {
    if (!existsSync(file('pem'))) fail(`no key named ${label}`);
    const key = createPrivateKey(readFileSync(file('pem')));
    const pub = (await import('node:crypto')).createPublicKey(key);
    console.log(point(pub));
    break;
  }
  case 'sign': {
    if (!existsSync(file('pem'))) fail(`no key named ${label}`);
    appendFileSync(join(here, 'prompts.log'), `Touch ID: ${reason ?? 'TeamCLI owner seat signature'}\n`);
    const msg = Buffer.from(stdin(), 'hex');
    console.log(sign('sha256', msg, { key: createPrivateKey(readFileSync(file('pem'))), dsaEncoding: 'der' }).toString('hex'));
    break;
  }
  case 'pin-set': {
    if (existsSync(file('pin'))) fail('pin exists');
    writeFileSync(file('pin'), stdin(), { mode: 0o600 });
    console.log('ok');
    break;
  }
  case 'pin-get': {
    if (!existsSync(file('pin'))) fail(`no pin named ${label}`);
    console.log(readFileSync(file('pin'), 'utf8').trim());
    break;
  }
  default: fail(`unknown command ${command}`);
}
