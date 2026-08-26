/**
 * The byte-level grammar of Altium's binary PCB library.
 *
 * Everything in the format is little-endian, and almost everything is a block:
 * a uint32 length followed by that many bytes. A string block is a block whose
 * payload is a Pascal short string (one length byte, then Windows-1252 text). A
 * parameter block is a block whose payload is a NUL-terminated `|KEY=VALUE`
 * run. Getting a length wrong does not corrupt one field, it desynchronises
 * every field after it, so all three constructions live here rather than being
 * spelled out at each call site.
 *
 * Text is Windows-1252 because that is what pyaltiumlib decodes with and what
 * Altium wrote. Characters outside it cannot be represented and are refused
 * rather than silently mangled into a different designator.
 */

import { AltiumEmitError } from "./units";

export class ByteWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  u8(value: number): this {
    return this.push(Buffer.from([value & 0xff]));
  }

  u16(value: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value & 0xffff, 0);
    return this.push(buffer);
  }

  i16(value: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16LE(value, 0);
    return this.push(buffer);
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    return this.push(buffer);
  }

  double(value: number): this {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleLE(value, 0);
    return this.push(buffer);
  }

  bytes(value: Buffer | Uint8Array): this {
    return this.push(Buffer.from(value));
  }

  /** `[uint32 length][payload]`, the universal container in this format. */
  block(payload: Buffer | Uint8Array): this {
    return this.u32(payload.length).bytes(payload);
  }

  /** A block holding a Pascal short string. Used for names and designators. */
  stringBlock(value: string): this {
    const encoded = encodeAltiumText(value);
    if (encoded.length > 255) {
      throw new AltiumEmitError(
        `"${value}" is ${encoded.length} bytes; an Altium string block holds at most 255.`
      );
    }
    const payload = Buffer.alloc(encoded.length + 1);
    payload[0] = encoded.length;
    encoded.copy(payload, 1);
    return this.block(payload);
  }

  /** A block holding a NUL-terminated `|KEY=VALUE` run, Altium's parameter collection. */
  parameterBlock(parameters: Array<[string, string]>): this {
    const text = parameters.map(([key, value]) => `|${key}=${value}`).join("");
    const encoded = encodeAltiumText(text);
    const payload = Buffer.alloc(encoded.length + 1);
    encoded.copy(payload, 0);
    payload[encoded.length] = 0;
    return this.block(payload);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }

  private push(buffer: Buffer): this {
    this.chunks.push(buffer);
    this.length += buffer.length;
    return this;
  }
}

/**
 * The 0x80-0x9F block, which is the whole reason Windows-1252 is not Latin-1.
 *
 * ## The bug this table replaces
 *
 * The encoder used to accept any code point up to 0xFF and write it out as that
 * byte, under a comment saying "everything else in 0x00-0xFF maps". That is
 * true of Latin-1 and false of Windows-1252, and it was wrong in BOTH
 * directions at once.
 *
 * It REFUSED the twenty-six characters this block actually holds. An LMP7704-SP
 * prints a pin name containing a U+2013 en dash, which Windows-1252 encodes
 * perfectly well as 0x96, and the Altium export died on it. Reported
 * 2026-08-24 as "export failed", and it took the whole bundle down: the route
 * did not catch the error, so it went out as a 500 and the screen showed the
 * bare words "Export failed."
 *
 * And it silently ACCEPTED U+0080 to U+009F, the C1 control characters, writing
 * each as the byte of the same number. Those bytes are not controls in
 * Windows-1252, they are this table. A stray U+0096 in a pin name would have
 * arrived in Altium as an en dash nobody typed, which is the "silently
 * substituting a character would put a wrong designator on a pad" failure the
 * original comment was written to prevent, produced by the check itself.
 *
 * Mapping is by Unicode code point, in the direction the encoder actually needs.
 */
const WINDOWS_1252_HIGH = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f]
]);

/**
 * Encodes text as Windows-1252, refusing anything that does not fit.
 *
 * Part numbers, package names and PIN NAMES reach here from an extracted
 * datasheet, so this is also where a value that cannot be written honestly
 * stops. Silently substituting "?" for a character would put a wrong designator
 * on a pad. Refusing a character the encoding does hold is the opposite error
 * and costs the user the whole export; see `WINDOWS_1252_HIGH`.
 */
export function encodeAltiumText(value: string): Buffer {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const mapped =
      code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : WINDOWS_1252_HIGH.get(code);
    if (mapped === undefined) {
      throw new AltiumEmitError(
        `"${value}" contains a character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) that Altium's Windows-1252 strings cannot represent.`
      );
    }
    bytes.push(mapped);
  }
  return Buffer.from(bytes);
}

/**
 * Strips a value of the characters that would break out of a `|KEY=VALUE`
 * parameter run.
 *
 * `|` starts a new key, `=` starts a new value, and a NUL ends the collection.
 * These reach the file from datasheet-derived text, so this is the same sink
 * hardening the KiCad emitter applies to its quoted strings, spelled for this
 * format.
 */
export function parameterSafe(value: string): string {
  return value.replace(/[|=\u0000\r\n]+/g, " ").trim();
}

/**
 * The name of the compound-file storage holding a component.
 *
 * Altium truncates to 31 characters and replaces the characters a storage name
 * cannot hold. pyaltiumlib applies the identical rule when it looks a component
 * up, so a name mangled here is still found there. The untruncated name stays in
 * the library index and in the component's own data, which is where readers take
 * the name they report from.
 */
export function storageName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 31);
  return cleaned.length > 0 ? cleaned : "_";
}
