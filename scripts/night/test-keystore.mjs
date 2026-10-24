#!/usr/bin/env node
// A TEST owner-seat keystore for isolated homes only: the same command line as the Secure Enclave
// helper (create, public, sign, pin-set, pin-get), with software P-256 keys kept in files under
// the home it is installed in. No user presence, no Secure Enclave: never install it in a real
// home. It refuses to run when HOME is not under /tmp or /private/tmp.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const home = process.env.HOME ?? '';
if (!/^\/(private\/)?tmp\//.test(home)) {
  process.stderr.write('test keystore: refused outside an isolated /tmp home\n');
  process.exit(3);
}
const dir = join(home, '.config', 'team-owner-seat', 'test-keys');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = (label, kind) => join(dir, `${createHash('sha256').update(label).digest('hex').slice(0, 32)}.${kind}`);
const raw = (pub) => {
  const jwk = pub.export({ format: 'jwk' });
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};
const stdin = () => readFileSync(0, 'utf8').trim();
const [cmd, label] = process.argv.slice(2);
try {
  if (cmd === 'create') {
    if (existsSync(file(label, 'pem'))) throw new Error('exists');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(file(label, 'pem'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    process.stdout.write(raw(pair.publicKey));
  } else if (cmd === 'public') {
    process.stdout.write(raw(createPrivateKey(readFileSync(file(label, 'pem')))));
  } else if (cmd === 'sign') {
    const key = createPrivateKey(readFileSync(file(label, 'pem')));
    process.stdout.write(sign('sha256', Buffer.from(stdin(), 'hex'), { key, dsaEncoding: 'der' }).toString('hex'));
  } else if (cmd === 'pin-set') {
    if (existsSync(file(label, 'pin'))) throw new Error('exists');
    writeFileSync(file(label, 'pin'), stdin(), { mode: 0o600 });
  } else if (cmd === 'pin-get') {
    process.stdout.write(readFileSync(file(label, 'pin'), 'utf8'));
  } else {
    throw new Error('usage');
  }
} catch (e) {
  process.stderr.write(`test keystore: ${e.message}\n`);
  process.exit(1);
}
