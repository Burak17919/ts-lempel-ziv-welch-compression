# ts-lempel-ziv-welch-compression

Compress and decompress text using the Lempel–Ziv–Welch algorithm, exposed as two pure functions: `compress(input: string): string` and `decompress(data: string): string`. Output is a binary string (each character code is one byte, 0–255) suitable for transport through any channel that accepts strings.

## Usage

```js
import { compress, decompress } from 'ts-lempel-ziv-welch-compression';

const text = 'the rain in spain falls mainly on the plain, again and again';
const packed = compress(text);
const restored = decompress(packed);

console.log(restored === text); // true
console.log(packed.length < text.length * 2); // true
```

The codec is also exported directly as `LZWCodec` for callers who want a stable object handle.

## Why this exists

This library is for situations where you need a small, dependency-free way to shrink repetitive text payloads inside a JavaScript application — config blobs, log lines, repeated template fragments — and a full compression dependency is more weight than the problem deserves. It trades raw compression ratio for implementation simplicity: the whole codec is a few hundred lines with no native bindings.

## Design decisions (read these before relying on the library)

- **Character granularity, not byte granularity.** The dictionary operates on UTF-16 code units. Each input string is treated as a sequence of 16-bit code units, so non-BMP characters (emoji, astral-plane symbols) are handled as surrogate pairs and round-trip correctly as long as you treat the output as opaque.
- **Variable-width codes, 17 to 24 bits.** Codes start at 17 bits (one wider than a raw code unit) and grow by one bit each time the dictionary fills, up to a 24-bit cap. The cap bounds memory and keeps the decoder's integer arithmetic inside JavaScript's safe range.
- **Binary string output.** Packed data is a string of byte-valued characters. This avoids any `Buffer` or `TypedArray` dependency and works in any JS environment, at the cost of using two bytes of string storage per byte of payload. If you need a true byte buffer, convert with a `Uint8Array` from the char codes.

## The awkward edge

The one behaviour that surprises people: the output of `compress` is **not** valid UTF-8. It is a binary string. Do not try to send it through a JSON channel that expects text, or store it in a text column that enforces an encoding. Encode it as Base64 first if you need a text-safe representation.
