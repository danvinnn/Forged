"""Reads a .PcbLib with pyaltiumlib and prints what it found as JSON.

This is the oracle for the Altium generator: an independent implementation that
has never seen our writer. It matters because Altium refuses a malformed library
without saying anything, so a subtly wrong writer and a correct one look exactly
alike until somebody opens Altium.

Two things are reported and both are load-bearing:

  * the geometry, so the test can check that what was written came back;
  * every warning and error pyaltiumlib logged, because it does not raise on a
    malformed record, it logs and carries on. A file that parses to plausible
    values while logging "common parameters array spacer is not as expected" is
    a broken file, and only the log says so.

Usage: python3 altium-oracle.py <path to .PcbLib>
"""

import json
import logging
import re
import sys

try:
    import pyaltiumlib
except ImportError:  # pragma: no cover - reported to the caller as JSON
    print(json.dumps({"error": "pyaltiumlib is not installed; the Altium oracle cannot run"}))
    sys.exit(2)


class Collector(logging.Handler):
    """Captures everything pyaltiumlib complains about instead of printing it.

    Two different kinds of message arrive here and conflating them would be a
    mistake in either direction:

      * "Found unsupported RecordID=N" says the READER does not implement a
        record. It says nothing about whether the file is correct. pyaltiumlib's
        schematic reader stops at record 44, so the footprint link is invisible
        to it by construction.
      * everything else is pyaltiumlib finding the FILE wrong: a bad block
        length, a spacer that is not what it should be, a truncated stream.

    So they are reported separately. The second list must be empty. The first is
    a statement about coverage, and every record in it is checked by the second
    oracle in tools/altium-oracle, which does implement them.
    """

    UNSUPPORTED = re.compile(r"Found unsupported Record(ID|Type)=(\d+)")

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages = []
        self.unsupported = []

    def emit(self, record):
        message = record.getMessage()
        match = self.UNSUPPORTED.search(message)
        if match:
            self.unsupported.append(int(match.group(2)))
        else:
            self.messages.append(f"{record.levelname}:{record.name}:{message}")


def coordinate(value):
    return None if value is None else float(value)


def point(value):
    return {"x": float(value.x), "y": float(value.y)}


def describe(record):
    kind = type(record).__name__
    common = {"kind": kind, "layer": getattr(record, "layer", None)}

    if kind == "PcbPad":
        common.update(
            {
                "designator": record.designator,
                "location": point(record.location),
                "sizeTop": point(record.size_top),
                "sizeMiddle": point(record.size_middle),
                "sizeBottom": point(record.size_bottom),
                "holeSize": coordinate(record.hole_size),
                "shapeTop": record.shape_top.to_int(),
                "shapeMiddle": record.shape_middle.to_int(),
                "shapeBottom": record.shape_bottom.to_int(),
                "rotation": record.rotation,
                "isPlated": record.is_plated,
                "stackMode": record.stack_mode,
                "hasRoundRect": record.has_round_rect,
                "topLayerShape": record.shape_layers[0].to_int() if record.shape_layers else None,
                "topCornerRadius": record.corner_radius_percentage[0] if record.corner_radius_percentage else None,
                "solderMaskExpansion": coordinate(record.expansion_solder_mask),
            }
        )
    elif kind == "PcbTrack":
        common.update(
            {"start": point(record.start), "end": point(record.end), "width": coordinate(record.linewidth)}
        )
    elif kind == "PcbArc":
        common.update(
            {
                "center": point(record.location),
                "radius": coordinate(record.radius),
                "startAngle": record.angle_start,
                "endAngle": record.angle_end,
                "width": coordinate(record.linewidth),
            }
        )
    elif kind == "PcbString":
        common.update(
            {
                "text": record.text,
                "corner": point(record.corner1),
                "height": coordinate(record.height),
                "strokeWidth": coordinate(record.stroke_width),
                "rotation": record.rotation,
                "textKind": record.text_kind.to_int() if hasattr(record, "text_kind") else None,
            }
        )
    elif kind == "PcbFill":
        common.update({"corner1": point(record.corner1), "corner2": point(record.corner2)})

    # Schematic records. Coordinates here are in schematic units of 10 mil, and
    # pyaltiumlib negates Y just as it does for the PCB.
    elif kind == "SchComponent":
        common.update(
            {"libReference": record.libreference, "description": record.component_description}
        )
    elif kind == "SchPin":
        common.update(
            {
                "designator": record.designator,
                "name": record.name,
                "location": point(record.location),
                "length": float(record.pinlength),
                "electricalType": record.electrical_type.to_int(),
                "rotated": bool(record.rotated),
                "flipped": bool(record.flipped),
                "showName": record.show_name,
                "showDesignator": record.show_designator,
            }
        )
    elif kind == "SchRectangle":
        common.update({"location": point(record.location), "corner": point(record.corner)})
    elif kind in ("SchDesignator", "SchParameter"):
        common.update({"text": record.text, "name": getattr(record, "name", None), "location": point(record.location)})

    return common


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: altium-oracle.py <path to .PcbLib>"}))
        return 2

    path = sys.argv[1]
    collector = Collector()
    root = logging.getLogger("pyaltiumlib")
    root.setLevel(logging.DEBUG)
    root.addHandler(collector)
    # Nothing should reach the console; the JSON on stdout is the whole result.
    logging.getLogger().addHandler(logging.NullHandler())

    try:
        library = pyaltiumlib.read(path)
    except Exception as error:  # the reader raises on a structurally broken file
        print(json.dumps({"error": f"{type(error).__name__}: {error}", "diagnostics": collector.messages,
                          "unsupportedRecords": sorted(set(collector.unsupported))}))
        return 1

    result = {
        "libHeader": library.LibHeader,
        "libType": library.LibType,
        "componentCount": library.ComponentCount,
        "parts": [
            {
                "name": part.Name,
                "description": part.Description,
                # A footprint's header states how many primitives follow; a
                # symbol has no such count.
                "recordCount": getattr(part, "_RecordCount", None),
                "designator": getattr(part, "Designator", None),
                "records": [describe(record) for record in part.Records],
            }
            for part in library.Parts
        ],
        "diagnostics": collector.messages,
        "unsupportedRecords": sorted(set(collector.unsupported)),
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
