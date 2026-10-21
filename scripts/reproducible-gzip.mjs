// The release tarball's gzip layer, pinned so the same commit packs to the
// same compressed bytes on every supported machine.
//
// 0.5.3 is the case this fixes: the local and hosted tarballs held the same
// uncompressed tar byte for byte (7,875,072 bytes, sha256 15aed741…), but their
// compressed hashes differed (304b4542… locally, ef485bcc… hosted) because the
// runtimes carried different zlib implementations. The gzip headers and
// trailers were identical; only the DEFLATE stream differed. The compressor is
// therefore fixed here — Node v22.23.3 with zlib 1.3.1-e00f703, level 9, and
// the stable header below — while the tar bytes themselves stay npm pack's.
//
//   node scripts/reproducible-gzip.mjs <input.tgz> <output.tgz>
//
// The input is gunzipped, its tar bytes are compressed again with the pinned
// compressor, and one JSON line reports the input, tar and output identities.
// Exit 2 when the runtime is not the pinned compressor, when the input cannot
// be read or is not gzip, or when the output cannot be written.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** The one compressor a release tarball may be built with. */
export const COMPRESSOR = Object.freeze({
  implementation: 'node:zlib',
  node: 'v22.23.3',
  zlib: '1.3.1-e00f703',
  level: 9,
  windowBits: 15,
  memLevel: 8,
  strategy: 0,
  gzipHeader: '1f8b08000000000002ff',
});

/** deflateRaw's parameters, fixed explicitly rather than left to defaults. */
export const DEFLATE_OPTIONS = Object.freeze({ level: 9, windowBits: 15, memLevel: 8, strategy: 0 });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 of the uncompressed bytes, as the gzip trailer stores it. */
export function crc32(input) {
  let c = 0xffffffff;
  for (const byte of input) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function defaultDeflateRaw(input) {
  return deflateRawSync(input, DEFLATE_OPTIONS);
}

/**
 * Wraps the raw DEFLATE bytes of `raw` in the fixed gzip frame. `deflateRaw`
 * is injectable so a test can prove the frame without depending on a runtime's
 * zlib; the default is the pinned one above.
 */
export function gzipDeterministic(raw, deflateRaw = defaultDeflateRaw) {
  if (!(raw instanceof Uint8Array)) throw new TypeError('reproducible-gzip: raw input must be bytes');
  const deflated = deflateRaw(raw, DEFLATE_OPTIONS);
  const header = Buffer.from(COMPRESSOR.gzipHeader, 'hex');
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw), 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, Buffer.from(deflated), trailer]);
}

/** Why this runtime cannot be the release compressor, or undefined when it is. */
export function toolchainProblem(actual = { node: process.version, zlib: process.versions.zlib }) {
  const wrong = [];
  if (actual.node !== COMPRESSOR.node) wrong.push(`Node ${actual.node}`);
  if (actual.zlib !== COMPRESSOR.zlib) wrong.push(`zlib ${actual.zlib}`);
  if (wrong.length === 0) return undefined;
  return (
    `the release compressor is pinned to Node ${COMPRESSOR.node} (zlib ${COMPRESSOR.zlib}); ` +
    `this run has ${wrong.join(' and ')}`
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: node scripts/reproducible-gzip.mjs <input.tgz> <output.tgz>');
    process.exit(2);
  }
  const problem = toolchainProblem();
  if (problem !== undefined) {
    console.error(`reproducible-gzip: ${problem}`);
    process.exit(2);
  }
  const [input, output] = argv;
  let tarball;
  try {
    tarball = readFileSync(input);
  } catch (error) {
    console.error(`reproducible-gzip: cannot read ${input}: ${error.message}`);
    process.exit(2);
  }
  let tar;
  try {
    tar = gunzipSync(tarball);
  } catch (error) {
    console.error(`reproducible-gzip: ${input} is not a gzip stream: ${error.message}`);
    process.exit(2);
  }
  const gzip = gzipDeterministic(tar);
  try {
    writeFileSync(output, gzip);
  } catch (error) {
    console.error(`reproducible-gzip: cannot write ${output}: ${error.message}`);
    process.exit(2);
  }
  console.log(
    JSON.stringify({
      compressor: COMPRESSOR,
      input: { sha256: sha256(tarball), bytes: tarball.length },
      tar: { sha256: sha256(tar), bytes: tar.length },
      output: { sha256: sha256(gzip), bytes: gzip.length },
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
