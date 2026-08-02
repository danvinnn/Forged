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
 * Encodes text as Windows-1252, refusing anything that does not fit.
 *
 * Part numbers and package names reach here from an extracted datasheet, so
 * this is also where a value that cannot be written honestly stops. Silently
 * substituting "?" for a character would put a wrong designator on a pad.
 */
export function encodeAltiumText(value: string): Buffer {
  const out = Buffer.alloc(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code > 0xff || WINDOWS_1252_UNMAPPED.has(code)) {
      throw new AltiumEmitError(
        `"${value}" contains a character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) that Altium's Windows-1252 strings cannot represent.`
      );
    }
    out[index] = code;
  }
  return out;
}

// The five byte values Windows-1252 leaves undefined. Everything else in
// 0x00-0xFF maps, and for 0x00-0x7F it is ASCII.
const WINDOWS_1252_UNMAPPED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

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
