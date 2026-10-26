import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compress, decompress, LZWCodec } from '../src/index.js';

/**
 * Round-trip a string through compress and decompress, asserting exact
 * equality. Pulled into a helper so each test reads as one line.
 *
 * @param {string} desc
 * @param {string} input
 */
function roundTrip(desc, input) {
  test(desc, () => {
    const packed = compress(input);
    const restored = decompress(packed);
    assert.equal(restored, input);
  });
}

roundTrip('empty string', '');
roundTrip('single character', 'A');
roundTrip('two characters', 'Hi');
roundTrip('repeated single character', 'aaaaaaa');
roundTrip('short word repeated', 'banana banana banana');
roundTrip('ascii sentence', 'The quick brown fox jumps over the lazy dog.');
roundTrip('digits', '012345678901234567890123456789');
roundTrip('mixed punctuation', '!?.,;:!?.,;:!?.,;:!?.,;:');
roundTrip('newlines and tabs', 'line1\nline2\n\tindented\n');

// A string long enough to force the code width to grow at least once.
// Without this, the width-growth branches in both encoder and decoder
// would be dead code as far as the test suite is concerned.
test('long input triggers width growth', () => {
  let input = '';
  for (let i = 0; i < 5000; i++) {
    input += 'abcdefghij'.charAt(i % 10);
  }
  const packed = compress(input);
  const restored = decompress(packed);
  assert.equal(restored, input);
  // Compression should actually reduce size for this repetitive input.
  assert.ok(packed.length < input.length * 2,
    'packed output should be smaller than naive 2-bytes-per-char storage');
});

// Non-BMP characters (astral plane) are represented as surrogate pairs
// in JavaScript strings, so they are handled as two UTF-16 code units.
// This test documents that behaviour explicitly rather than pretending
// the library operates on code points.
test('surrogate pair round-trips as two code units', () => {
  const input = 'to be or not to be \uD83D\uDE00';
  assert.equal(decompress(compress(input)), input);
});

// The classic LZW edge case: a pattern that causes the encoder to emit
// a code for an entry the decoder has not yet created. The input must
// contain a run where the same character repeats in a way that makes
// the dictionary build a self-referential entry.
test('kwkewkk triggers the decoder edge case', () => {
  const input = 'ababababababab';
  assert.equal(decompress(compress(input)), input);
});

test('compress then decompress is idempotent on randomish text', () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  let input = '';
  // A fixed pseudo-random sequence based on a simple LCG so the test
  // is deterministic across runs and machines.
  let seed = 42;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    input += chars.charAt(seed % chars.length);
  }
  assert.equal(decompress(compress(input)), input);
});

test('LZWCodec is exported as a namespace with compress and decompress', () => {
  assert.equal(typeof LZWCodec.compress, 'function');
  assert.equal(typeof LZWCodec.decompress, 'function');
});

test('decompressing an empty binary string returns empty string', () => {
  assert.equal(decompress(''), '');
});

test('compressing empty string returns empty string', () => {
  assert.equal(compress(''), '');
});
