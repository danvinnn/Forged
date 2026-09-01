"use client";

/**
 * THE FOOTPRINT, DRAWN.
 *
 * ## Why this exists
 *
 * Until now the only way to see what this product built was to open the files in
 * CAD. Everything on the screen was a number, so the question a person was being
 * asked was "do you believe our arithmetic", which nobody can answer by reading
 * a table of millimetres. Drawn, the question becomes "does that look like the
 * part", which an engineer answers in two seconds: a QFN with a row of pads down
 * one side, a pin 1 in the wrong corner, a thermal pad the size of the package,
 * a courtyard inside its own copper - all of these are obvious in a picture and
 * invisible in a list.
 *
 * ## It draws the geometry that SHIPS, and nothing else
 *
 * `PackageOption.geometry` is the object `createExportZip` writes into the
 * library, already through `validateGeometry`. It is carried out of the
 * generator rather than recomputed here, and that is the load-bearing decision:
 * a preview built by a second code path is a picture of something the user is
 * not going to get, which is worse than no picture. It invites them to approve
 * one footprint and download another.
 *
 * So there is no geometry in this file. Every number drawn is read off the
 * geometry; nothing is derived, defaulted or rounded into place.
 *
 * ## What is drawn, and what is deliberately not
 *
 * Copper, paste, the courtyard, the body outline, the thermal vias and the pin-1
 * marker. NOT the silkscreen: the emitters derive their own outlines
 * (`silkscreenTracks`), so this has nothing true to draw and would have to
 * invent it. An absent line is honest; a wrong one is the thing this file exists
 * to prevent.
 */

import { useMemo, useState } from "react";
import type { FootprintGeometry } from "../lib/geometry";

/** Millimetres of clear space around the courtyard, so nothing touches the frame. */
const MARGIN_MM = 0.6;

/**
 * The colours are KiCad's, on purpose.
 *
 * An engineer has looked at that palette for years: red top copper, purple-ish
 * courtyard, yellow fabrication outline. Borrowing it means the picture reads
 * without a legend, and getting it wrong means every glance costs a moment of
 * translation.
 */
const COPPER = "#c83434";
const COPPER_EDGE = "#e05a5a";
const PASTE = "#b0b0b0";
/**
 * The same word, dark enough to read on the caption.
 *
 * The legend sets each term in the colour it names, which works for every one of
 * them except paste: a light grey chosen to sit on black copper is invisible on
 * the caption's paper background. One colour cannot do both jobs, so there are
 * two, and only this one is ever set in text.
 */
const PASTE_INK = "#6b6b6b";
const COURTYARD = "#a05fb4";
const FABRICATION = "#c8a04b";
const VIA = "#2f7f4f";

/**
 * How big to draw the pin-1 dot, in millimetres.
 *
 * Scaled off the PACKAGE rather than off the view, because the view is sized
 * from this and the two would chase each other. A twentieth of the courtyard's
 * larger dimension is legible on a 2 mm chip and not overbearing on a 25 mm one.
 */
function markerRadiusMm(geometry: FootprintGeometry): number {
  return Math.max(geometry.courtyard.halfWidthMm, geometry.courtyard.halfHeightMm) / 10;
}

interface Props {
  geometry: FootprintGeometry;
  /** Shown under the drawing. The provenance line the manifest also carries. */
  source?: string;
}

export default function FootprintPreview({ geometry, source }: Props) {
  const [showPaste, setShowPaste] = useState(true);
  const [showCourtyard, setShowCourtyard] = useState(true);

  const view = useMemo(() => {
    // SIZED FROM WHAT IT MUST CONTAIN, not from the courtyard alone. The
    // courtyard is meant to contain everything and `geometryViolations` checks
    // that it does, but a preview that assumes the invariant holds cannot show
    // you the case where it does not - which is exactly the case worth seeing.
    let halfX = Math.max(geometry.courtyard.halfWidthMm, geometry.body.halfWidthMm);
    let halfY = Math.max(geometry.courtyard.halfHeightMm, geometry.body.halfHeightMm);
    for (const pad of geometry.pads) {
      halfX = Math.max(halfX, Math.abs(pad.centre.xMm) + pad.widthMm / 2);
      halfY = Math.max(halfY, Math.abs(pad.centre.yMm) + pad.heightMm / 2);
    }
    // AND THE PIN-1 MARKER, which sits OUTSIDE the copper by design and was
    // therefore the one thing that could fall off the edge of its own drawing.
    // Caught by looking at an ISO1050 SOP-8: the marker was drawn half outside
    // the frame, which is the worst possible thing to clip - a footprint correct
    // in every dimension and marked in the wrong corner is a part soldered
    // backwards, and this drawing exists mainly so that is visible.
    const marker = markerRadiusMm(geometry);
    halfX = Math.max(halfX, Math.abs(geometry.pin1Marker.xMm) + marker);
    halfY = Math.max(halfY, Math.abs(geometry.pin1Marker.yMm) + marker);
    const width = (halfX + MARGIN_MM) * 2;
    const height = (halfY + MARGIN_MM) * 2;
    return { width, height, minX: -width / 2, minY: -height / 2 };
  }, [geometry]);

  const lands = geometry.pads.filter((pad) => pad.number !== "");
  const apertures = geometry.pads.flatMap((pad) => pad.pasteApertures ?? []);
  // A stroke that is a fixed fraction of the drawing, so a 2 mm part and a 25 mm
  // one both come out legible. A fixed millimetre width disappears on one and
  // swamps the other.
  const hair = Math.max(view.width, view.height) / 400;

  return (
    <figure className="fp-preview">
      <svg
        viewBox={`${view.minX} ${view.minY} ${view.width} ${view.height}`}
        role="img"
        aria-label={`Scale drawing of the ${geometry.name} footprint: ${lands.length} lands`}
      >
        {showCourtyard && (
          <rect
            x={-geometry.courtyard.halfWidthMm}
            y={-geometry.courtyard.halfHeightMm}
            width={geometry.courtyard.halfWidthMm * 2}
            height={geometry.courtyard.halfHeightMm * 2}
            fill="none"
            stroke={COURTYARD}
            strokeWidth={hair}
            strokeDasharray={`${hair * 6} ${hair * 4}`}
          />
        )}

        <rect
          x={-geometry.body.halfWidthMm}
          y={-geometry.body.halfHeightMm}
          width={geometry.body.halfWidthMm * 2}
          height={geometry.body.halfHeightMm * 2}
          fill="none"
          stroke={FABRICATION}
          strokeWidth={hair}
        />

        {geometry.pads.map((pad, index) =>
          pad.shape === "circle" ? (
            <g key={`pad-${index}`}>
              <circle cx={pad.centre.xMm} cy={pad.centre.yMm} r={pad.widthMm / 2} fill={COPPER} stroke={COPPER_EDGE} strokeWidth={hair} />
              {pad.drillMm !== undefined && (
                <circle cx={pad.centre.xMm} cy={pad.centre.yMm} r={pad.drillMm / 2} fill="#1b1b1b" />
              )}
            </g>
          ) : (
            <rect
              key={`pad-${index}`}
              x={pad.centre.xMm - pad.widthMm / 2}
              y={pad.centre.yMm - pad.heightMm / 2}
              width={pad.widthMm}
              height={pad.heightMm}
              // A land's corners are rounded in both emitters, so they are
              // rounded here. The radius is the smaller half-dimension quartered,
              // which is what a roundrect land looks like at any size.
              rx={Math.min(pad.widthMm, pad.heightMm) / 4}
              fill={COPPER}
              stroke={COPPER_EDGE}
              strokeWidth={hair}
            />
          )
        )}

        {showPaste &&
          apertures.map((aperture, index) => (
            <rect
              key={`paste-${index}`}
              x={aperture.centre.xMm - aperture.widthMm / 2}
              y={aperture.centre.yMm - aperture.heightMm / 2}
              width={aperture.widthMm}
              height={aperture.heightMm}
              fill={PASTE}
              fillOpacity={0.75}
            />
          ))}

        {geometry.thermalVias.map((via, index) => (
          <g key={`via-${index}`}>
            <circle cx={via.centre.xMm} cy={via.centre.yMm} r={via.padMm / 2} fill={VIA} />
            <circle cx={via.centre.xMm} cy={via.centre.yMm} r={via.drillMm / 2} fill="#1b1b1b" />
          </g>
        ))}

        {/* PIN 1, WHICH IS THE WHOLE POINT OF LOOKING. A footprint correct in
            every dimension and marked in the wrong corner is a part soldered
            backwards, and it is the one defect a drawing catches instantly. */}
        <circle
          cx={geometry.pin1Marker.xMm}
          cy={geometry.pin1Marker.yMm}
          r={markerRadiusMm(geometry)}
          fill="#ffffff"
        />
      </svg>

      <figcaption>
        <span className="fp-legend">
          <b style={{ color: COPPER_EDGE }}>copper</b>
          {apertures.length > 0 && <b style={{ color: PASTE_INK }}>paste</b>}
          <b style={{ color: FABRICATION }}>body</b>
          <b style={{ color: COURTYARD }}>courtyard</b>
          {geometry.thermalVias.length > 0 && <b style={{ color: VIA }}>vias</b>}
          <b>&#9679; pin 1</b>
        </span>
        <span className="fp-facts">
          {lands.length} land{lands.length === 1 ? "" : "s"} &middot;{" "}
          {(geometry.courtyard.halfWidthMm * 2).toFixed(2)} &times; {(geometry.courtyard.halfHeightMm * 2).toFixed(2)} mm keep-out
          {geometry.thermalVias.length > 0 ? ` · ${geometry.thermalVias.length} thermal vias` : ""}
        </span>
        {apertures.length > 0 && (
          <label className="fp-toggle">
            <input type="checkbox" checked={showPaste} onChange={(event) => setShowPaste(event.target.checked)} /> paste
          </label>
        )}
        <label className="fp-toggle">
          <input type="checkbox" checked={showCourtyard} onChange={(event) => setShowCourtyard(event.target.checked)} /> courtyard
        </label>
        {source && <span className="fp-source">{source}</span>}
      </figcaption>
    </figure>
  );
}
