import { test } from "node:test";
import assert from "node:assert/strict";
import CFB from "cfb";
import { writeCompoundFile } from "../altium/container";

/**
 * The container carries what we put in it and nothing else.
 *
 * `cfb` seeds every compound file it builds with a four-byte stream of its own
 * at the root, `\u0001Sh33tJ5`, and re-adds it on every write. No Altium-written
 * library carries any stream with a control character in its name, so it was the
 * one thing in our output that Altium would never have produced. The writer now
 * unlinks it, and these tests are what keep it unlinked: a `cfb` upgrade that
 * changes the name, the shape of the directory chain, or when the stream is
 * seeded would otherwise put it back silently.
 */

const MARKER = "\u0001Sh33tJ5";

function paths(library: Buffer): string[] {
  const container = CFB.read(library, { type: "buffer" });
  return container.FullPaths.filter((path, index) => container.FileIndex[index].type !== 0);
}

test("the container holds exactly the streams it was given", () => {
  const library = writeCompoundFile([
    ["/FileHeader", Buffer.from("header")],
    ["/Library/Data", Buffer.from("data")],
    ["/Library/Header", Buffer.alloc(4)]
  ]);

  assert.deepEqual(paths(library).sort(), [
    "Root Entry/",
    "Root Entry/FileHeader",
    "Root Entry/Library/",
    "Root Entry/Library/Data",
    "Root Entry/Library/Header"
  ]);
});

test("no stream name carries a control character", () => {
  // The general form of the rule, so a differently named marker is caught too.
  const library = writeCompoundFile([
    ["/FileHeader", Buffer.from("header")],
    ["/Library/Data", Buffer.from("data")]
  ]);

  for (const path of paths(library)) {
    assert.ok(
      ![...path].some((character) => character.charCodeAt(0) < 0x20),
      `stream name ${JSON.stringify(path)} carries a control character`
    );
  }
});

test("removing the marker leaves every other stream readable", () => {
  // The splice edits sibling pointers in the directory. If it got one wrong, the
  // streams after the marker in the chain are the ones that would go missing, so
  // the contents are checked and not just the names.
  const contents: Array<[string, Buffer]> = [
    ["/FileHeader", Buffer.from("PCB 6.0 Binary Library File")],
    ["/Library/Data", Buffer.from([1, 2, 3, 4, 5])],
    ["/Library/ComponentParamsTOC/Data", Buffer.from("Name=X|Pad Count=1")],
    ["/PART/Data", Buffer.from([0xff, 0x00, 0xff])],
    ["/PART/WideStrings", Buffer.from("wide", "utf16le")]
  ];

  const container = CFB.read(writeCompoundFile(contents), { type: "buffer" });
  for (const [path, expected] of contents) {
    const entry = CFB.find(container, path);
    assert.ok(entry, `${path} survived`);
    assert.deepEqual(Buffer.from(entry.content as Uint8Array), expected, `${path} is intact`);
  }
});

test("the marker is what cfb would have written without the removal", () => {
  // Guards the other direction. If cfb ever stops seeding the stream, the
  // removal becomes dead code and should go, and this is the test that says so.
  const seeded = CFB.utils.cfb_new();
  CFB.utils.cfb_add(seeded, "/Library/Data", Buffer.from([1]));
  const raw = CFB.read(CFB.write(seeded, { type: "buffer" }) as Buffer, { type: "buffer" });

  assert.ok(
    raw.FullPaths.includes(`Root Entry/${MARKER}`),
    "cfb still seeds the marker, so removing it is still doing something"
  );
});
