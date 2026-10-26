/**
 * Core LZW algorithm, split from index.js to keep the entry point thin.
 *
 * --- Design choices (stated plainly so users know what they bought) ---
 *
 * 1. Character granularity. We operate on UTF-16 code units, not bytes.
 *    This means the dictionary starts with the full range 0..65535 and
 *    codes are unsigned integers. It is the simplest choice for a pure
 *    string-in/string-out API and avoids UTF-8 boundary bugs at the cost
 *    of efficiency on predominantly ASCII input.
 *
 * 2. Variable-width codes. We start emitting codes at 17 bits (one more
 *    than the fixed 16-bit character width, so the first multi-character
 *    code is distinguishable from a raw code unit) and grow the width by
 *    one bit each time the dictionary doubles, up to a hard cap of 24
 *    bits. The cap keeps memory bounded and the decoder's growth logic
 *    simple: it never has to reason about overflow of a 32-bit code into
 *    a width that would exceed JavaScript's safe integer range during
 *    intermediate accumulation.
 *
 * 3. Binary-string transport. Output is a string whose char codes are
 *    raw bytes (0..255). This is the lowest-friction way to move binary
 *    data through a pure-JS API without a Buffer or Uint8Array dependency.
 *    The trade-off is that each byte occupies two bytes in a JS string,
 *    so on-disk size is larger than a true byte buffer. That is acceptable
 *    for the stated use case (small text payloads).
 */

const INITIAL_CODE_WIDTH = 17;
const MAX_CODE_WIDTH = 24;

/**
 * Pack an array of byte values (0..255) into a JS string, one byte per
 * character. We use String.fromCharCode applied to the whole array at
 * once because it is measurably faster than repeated concatenation on
 * large inputs and avoids quadratic string building.
 *
 * @param {number[]} bytes
 * @returns {string}
 */
function bytesToString(bytes) {
  return String.fromCharCode.apply(null, bytes);
}

/**
 * Stateful wrapper around the compressor's output buffer. The reason we
 * use a class instead of bare functions is that the bit-packing state
 * (current byte, bit offset) must be threaded through every `writeCode`
 * call, and passing three mutable values by hand is error-prone.
 */
class BitWriter {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
    /** @type {number} */
    this.currentByte = 0;
    /** @type {number} Number of bits already written into currentByte (0..7). */
    this.bitsInByte = 0;
  }

  /**
   * Write `width` low-order bits of `code` to the stream, MSB-first within
   * each byte. MSB-first is used because it matches the most common LZW
   * reference implementations and makes the byte boundaries predictable
   * for debugging.
   *
   * @param {number} code
   * @param {number} width
   */
  writeCode(code, width) {
    let remaining = code;
    let bitsLeft = width;
    while (bitsLeft > 0) {
      const space = 8 - this.bitsInByte;
      const take = Math.min(space, bitsLeft);
      // Shift the bits we want into the lowest position of the chunk we
      // are adding, then align them to the top of the remaining space in
      // the current byte.
      const chunk = (remaining >> (bitsLeft - take)) << (space - take);
      this.currentByte |= chunk;
      this.bitsInByte += take;
      bitsLeft -= take;
      if (this.bitsInByte === 8) {
        this.bytes.push(this.currentByte & 0xff);
        this.currentByte = 0;
        this.bitsInByte = 0;
      }
    }
  }

  /**
   * Flush any partial byte to the buffer. Must be called exactly once at
   * the end of a compression run; the decoder relies on the final partial
   * byte being present.
   */
  flush() {
    if (this.bitsInByte > 0) {
      this.bytes.push(this.currentByte & 0xff);
      this.currentByte = 0;
      this.bitsInByte = 0;
    }
  }
}

/**
 * Reads variable-width codes MSB-first from a sequence of bytes. Mirrors
 * BitWriter so the two stay in lockstep.
 */
class BitReader {
  /**
   * @param {number[]} bytes
   */
  constructor(bytes) {
    this.bytes = bytes;
    this.bytePos = 0;
    this.bitsInByte = 0;
  }

  /**
   * Read `width` bits as an unsigned integer, or return null if the
   * stream is exhausted. Returning null (rather than throwing) lets the
   * decoder loop terminate cleanly when it has consumed exactly the codes
   * that were written.
   *
   * @param {number} width
   * @returns {number|null}
   */
  readCode(width) {
    let code = 0;
    let bitsLeft = width;
    while (bitsLeft > 0) {
      if (this.bytePos >= this.bytes.length) {
        return null;
      }
      const space = 8 - this.bitsInByte;
      const take = Math.min(space, bitsLeft);
      const byte = this.bytes[this.bytePos];
      // Pull the top `take` bits of the unread portion of the current byte.
      const chunk = (byte >> (space - take)) & ((1 << take) - 1);
      code = (code << take) | chunk;
      this.bitsInByte += take;
      bitsLeft -= take;
      if (this.bitsInByte === 8) {
        this.bytePos++;
        this.bitsInByte = 0;
      }
    }
    return code;
  }
}

/**
 * The codec. Exposed as `LZWCodec` so advanced users can construct it
 * directly if they ever need to, though the top-level `compress` and
 * `decompress` functions are the intended API.
 */
export const LZWCodec = {
  /**
   * Compress `input` to a binary string.
   *
   * The dictionary is a plain object keyed by string. We deliberately do
   * not use a Map here: for short string keys, V8's object property
   * access is as fast as Map.get and the code reads more naturally.
   *
   * @param {string} input
   * @returns {string}
   */
  compress(input) {
    const writer = new BitWriter();

    // Seed the dictionary with every possible single code unit. Starting
    // at 65536 means the first multi-character code is 65536, which
    // requires 17 bits to represent — hence INITIAL_CODE_WIDTH.
    /** @type {Record<string, number>} */
    const dict = {};
    let nextCode = 0;
    for (let c = 0; c < 65536; c++) {
      dict[String.fromCharCode(c)] = nextCode++;
    }

    let width = INITIAL_CODE_WIDTH;
    let maxCodeForWidth = (1 << width) - 1;

    if (input.length === 0) {
      writer.flush();
      return bytesToString(writer.bytes);
    }

    let w = input.charAt(0);
    for (let i = 1; i < input.length; i++) {
      const ch = input.charAt(i);
      const wc = w + ch;
      if (dict[wc] !== undefined) {
        w = wc;
      } else {
        writer.writeCode(dict[w], width);
        dict[wc] = nextCode++;
        // Grow the code width when the dictionary fills the current
        // width's range. The check is `>` rather than `>=` because we
        // compare against the largest code that fits in `width` bits.
        if (nextCode > maxCodeForWidth && width < MAX_CODE_WIDTH) {
          width++;
          maxCodeForWidth = (1 << width) - 1;
        }
        w = ch;
      }
    }
    writer.writeCode(dict[w], width);
    writer.flush();
    return bytesToString(writer.bytes);
  },

  /**
   * Decompress a binary string back to plaintext.
   *
   * @param {string} data
   * @returns {string}
   */
  decompress(data) {
    /** @type {number[]} */
    const bytes = [];
    for (let i = 0; i < data.length; i++) {
      bytes.push(data.charCodeAt(i) & 0xff);
    }
    const reader = new BitReader(bytes);

    // Mirror of the compressor's initial dictionary, but keyed by code
    // instead of by string, since lookups during decoding go the other
    // direction.
    /** @type {string[]} */
    const dict = [];
    for (let c = 0; c < 65536; c++) {
      dict[c] = String.fromCharCode(c);
    }
    let nextCode = 65536;

    let width = INITIAL_CODE_WIDTH;
    let maxCodeForWidth = (1 << width) - 1;

    const firstCode = reader.readCode(width);
    if (firstCode === null) {
      return '';
    }
    // The first code is always a single-character entry that exists in
    // the seed dictionary, so we can emit it directly.
    let prev = dict[firstCode];
    let out = [prev];

    let code;
    while ((code = reader.readCode(width)) !== null) {
      let entry;
      if (dict[code] !== undefined) {
        entry = dict[code];
      } else if (code === nextCode) {
        // The classic LZW edge case: the decoder encounters a code that
        // refers to an entry it has not yet finished creating. This
        // happens when the encoder emits a code for a string whose last
        // character is the first character of that same string. The
        // resolution is well known: entry = prev + prev[0].
        entry = prev + prev.charAt(0);
      } else {
        // A code that is neither in the dictionary nor equal to
        // nextCode means the stream is corrupt for this codec's
        // parameters. Rather than silently produce garbage, throw so
        // the caller knows the input was not valid LZW output.
        throw new Error('LZW decompression error: invalid code ' + code);
      }
      out.push(entry);
      dict[nextCode++] = prev + entry.charAt(0);
      if (nextCode > maxCodeForWidth && width < MAX_CODE_WIDTH) {
        width++;
        maxCodeForWidth = (1 << width) - 1;
      }
      prev = entry;
    }

    return out.join('');
  },
};
