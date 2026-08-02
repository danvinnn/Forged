/**
 * The OLE compound file both Altium libraries are packaged in.
 *
 * A compound file is a filesystem inside a file: storages are directories,
 * streams are files. `.PcbLib` and `.SchLib` differ entirely in what they put
 * in it, so the container itself is the one thing they share.
 *
 * ## The marker stream
 *
 * The `cfb` package seeds every container it builds with a four-byte stream of
 * its own at the root, named `\x01Sh33tJ5`, and re-adds it on every write, so it
 * cannot be removed by deleting it before the write. None of the 198 Altium-
 * written libraries in AltiumSharp's corpus carries any stream with a control
 * character in its name, so this was the one thing in our containers that Altium
 * would never have put there.
 *
 * It was almost certainly harmless: both oracles read past it without comment,
 * and readers address streams by name rather than enumerating them. But "almost
 * certainly harmless" is the state of belief this whole emitter exists to avoid,
 * and Altium refuses a file it dislikes without saying so. So it is removed after
 * the write instead, by `removeMarkerStream` below.
 */

import CFB from "cfb";

/** One stream: an absolute path inside the container, and its bytes. */
export type CompoundEntry = [path: string, content: Buffer];

/**
 * The stream `cfb` seeds every container with. The leading 0x01 is the OLE
 * convention for a stream belonging to the implementation rather than to the
 * document, which is why it is inert, and also why it is not ours to ship.
 */
const MARKER_NAME = "\u0001Sh33tJ5";

/** Compound-file constants, from MS-CFB. */
const DIRECTORY_ENTRY_BYTES = 128;
const NOSTREAM = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const MAX_DIFAT_IN_HEADER = 109;

/** Directory entry field offsets, from MS-CFB section 2.6.1. */
const ENTRY = {
  nameLength: 64,
  objectType: 66,
  leftSibling: 68,
  rightSibling: 72,
  child: 76
} as const;

const OBJECT_TYPE_UNUSED = 0;

export function writeCompoundFile(entries: CompoundEntry[]): Buffer {
  const container = CFB.utils.cfb_new();
  for (const [path, content] of entries) {
    CFB.utils.cfb_add(container, path, content);
  }
  return removeMarkerStream(CFB.write(container, { type: "buffer" }) as Buffer);
}

/**
 * Unlinks the `cfb` marker stream from the written container.
 *
 * Every directory entry is a node in a tree of siblings, and `cfb` builds that
 * tree as a degenerate right-leaning chain: every node has no left child, and
 * points at the next name through its right sibling. Removing a node from a
 * chain is a splice, so this needs none of the rebalancing a real red-black
 * deletion would.
 *
 * The chain shape is checked rather than assumed. If the marker ever turns up
 * with a left sibling or a child, the assumption behind the splice is wrong and
 * the buffer is returned untouched: an inert extra stream is a far better
 * outcome than a directory tree with a bad pointer in it, which is a library
 * that no longer opens anywhere.
 *
 * The marker's four bytes stay allocated in the mini stream, unreferenced. That
 * is space nobody reads, and freeing it would mean editing the mini FAT for no
 * gain.
 */
function removeMarkerStream(buffer: Buffer): Buffer {
  const sectorSize = 1 << buffer.readUInt16LE(0x1e);
  const directory = directoryEntryOffsets(buffer, sectorSize);
  if (directory === null) return buffer;

  const markerId = directory.findIndex((offset) => entryName(buffer, offset) === MARKER_NAME);
  if (markerId === -1) return buffer;

  const marker = directory[markerId];
  const left = buffer.readUInt32LE(marker + ENTRY.leftSibling);
  const right = buffer.readUInt32LE(marker + ENTRY.rightSibling);
  const child = buffer.readUInt32LE(marker + ENTRY.child);
  if (left !== NOSTREAM || child !== NOSTREAM) return buffer;

  // Whoever points at the marker inherits whatever the marker pointed at.
  let relinked = false;
  for (const offset of directory) {
    if (offset === marker) continue;
    for (const field of [ENTRY.leftSibling, ENTRY.rightSibling, ENTRY.child] as const) {
      if (buffer.readUInt32LE(offset + field) === markerId) {
        buffer.writeUInt32LE(right, offset + field);
        relinked = true;
      }
    }
  }
  if (!relinked) return buffer;

  buffer.fill(0, marker, marker + DIRECTORY_ENTRY_BYTES);
  buffer.writeUInt8(OBJECT_TYPE_UNUSED, marker + ENTRY.objectType);
  buffer.writeUInt32LE(NOSTREAM, marker + ENTRY.leftSibling);
  buffer.writeUInt32LE(NOSTREAM, marker + ENTRY.rightSibling);
  buffer.writeUInt32LE(NOSTREAM, marker + ENTRY.child);

  return buffer;
}

/**
 * The byte offset of every directory entry, in directory order, by walking the
 * directory chain through the FAT.
 *
 * Returns null rather than guessing if the file needs a DIFAT beyond the 109
 * entries the header holds. That takes a container far larger than a footprint
 * library, and a wrong offset here would corrupt one.
 */
function directoryEntryOffsets(buffer: Buffer, sectorSize: number): number[] | null {
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  if (fatSectorCount > MAX_DIFAT_IN_HEADER) return null;

  const fat: number[] = [];
  for (let index = 0; index < fatSectorCount; index += 1) {
    const fatSector = buffer.readUInt32LE(0x4c + index * 4);
    const start = sectorOffset(fatSector, sectorSize);
    if (start + sectorSize > buffer.length) return null;
    for (let entry = 0; entry < sectorSize / 4; entry += 1) {
      fat.push(buffer.readUInt32LE(start + entry * 4));
    }
  }

  const offsets: number[] = [];
  const entriesPerSector = sectorSize / DIRECTORY_ENTRY_BYTES;
  const seen = new Set<number>();

  let sector = buffer.readUInt32LE(0x30);
  while (sector !== ENDOFCHAIN && sector !== NOSTREAM) {
    if (seen.has(sector) || sector >= fat.length) return null;
    seen.add(sector);

    const start = sectorOffset(sector, sectorSize);
    if (start + sectorSize > buffer.length) return null;
    for (let entry = 0; entry < entriesPerSector; entry += 1) {
      offsets.push(start + entry * DIRECTORY_ENTRY_BYTES);
    }

    sector = fat[sector];
  }

  return offsets;
}

/**
 * Sector 0 begins after the header. The header is always 512 bytes, but with
 * 4096-byte sectors it is padded out to fill one, so a sector's offset is one
 * sector further in than its index either way.
 */
function sectorOffset(sector: number, sectorSize: number): number {
  return (sector + 1) * sectorSize;
}

/** The UTF-16LE name of a directory entry, without its terminator. */
function entryName(buffer: Buffer, offset: number): string {
  const length = buffer.readUInt16LE(offset + ENTRY.nameLength);
  if (length < 2 || length > 64) return "";
  return buffer.toString("utf16le", offset, offset + length - 2);
}
