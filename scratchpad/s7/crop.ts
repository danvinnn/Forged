import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Crop a rendered page so a dimension can be read at full resolution. mupdf is
// already a dependency and can render a clipped region directly, which is
// sharper than scaling a PNG.
async function main() {
  const [part, page, x0, y0, x1, y1, dpi] = process.argv.slice(2);
  const mupdf = await import("mupdf");
  const bytes = readFileSync(join(process.cwd(), ".bench-cache", `${part}.pdf`));
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const p = doc.loadPage(Number(page) - 1);
  const scale = Number(dpi ?? 400) / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);
  const box = p.getBounds();
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const clip = [
    box[0] + w * Number(x0),
    box[1] + h * Number(y0),
    box[0] + w * Number(x1),
    box[1] + h * Number(y1)
  ] as [number, number, number, number];
  // A Pixmap with an explicit bbox plus a DrawDevice, because `toPixmap` has no
  // clip argument in this build: the pixmap IS the clip.
  const scaled: [number, number, number, number] = [
    clip[0] * scale,
    clip[1] * scale,
    clip[2] * scale,
    clip[3] * scale
  ];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, scaled, false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  p.run(device, matrix);
  device.close();
  const out = join("scratchpad/s7", `${part}-p${page}-crop.png`);
  writeFileSync(out, Buffer.from(pixmap.asPNG()));
  console.log(out, pixmap.getWidth() + "x" + pixmap.getHeight());
}
void main();
