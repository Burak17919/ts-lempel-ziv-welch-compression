/**
 * Public entry point for the LZW library.
 *
 * We export a single namespace object so the package surface is stable.
 * All real work is done in core.js, which handles the bit-level stream
 * and the code-table mechanics.
 */
import { LZWCodec } from './core.js';

/**
 * Compress a UTF-8 string into a binary string of packed codes.
 *
 * @param {string} input - Plain text to compress.
 * @returns {string} A string whose character codes are packed LZW output bytes.
 */
export function compress(input) {
  return LZWCodec.compress(input);
}

/**
 * Decompress a binary string produced by `compress` back into the
 * original plain text.
 *
 * @param {string} data - A binary string from `compress`.
 * @returns {string} The original plaintext.
 */
export function decompress(data) {
  return LZWCodec.decompress(data);
}

export { LZWCodec };
