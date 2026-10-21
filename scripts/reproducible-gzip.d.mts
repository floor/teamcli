export type DeflateOptions = { readonly level: 9; readonly windowBits: 15; readonly memLevel: 8; readonly strategy: 0 };

export type DeflateRaw = (input: Uint8Array, options: DeflateOptions) => Uint8Array;

export type Compressor = {
  readonly implementation: 'node:zlib';
  readonly node: 'v22.23.3';
  readonly zlib: '1.3.1-e00f703';
  readonly level: 9;
  readonly windowBits: 15;
  readonly memLevel: 8;
  readonly strategy: 0;
  readonly gzipHeader: '1f8b08000000000002ff';
};

export const COMPRESSOR: Compressor;
export const DEFLATE_OPTIONS: DeflateOptions;
export function crc32(input: Uint8Array): number;
export function gzipDeterministic(raw: Uint8Array, deflateRaw?: DeflateRaw): Buffer;
export function toolchainProblem(actual?: { node: string; zlib: string }): string | undefined;
