"""Reads a .kicad_sym or .kicad_mod with kiutils and prints what it found as JSON.

The KiCad oracle, and the reason it exists is the same as the Altium one: until
this was written, the KiCad output was checked only by our own regexes matching
text our own code had just produced, which proves nothing except that the string
we built is the string we built.

kiutils is an independent implementation that has never seen our writer. It is
not KiCad itself, so it cannot say "Altium would open this"; what it can say is
"a reader that did not write this file recovers the same pins, pads and links
from it".

One finding from wiring it up, worth keeping: it reported zero units for a symbol
whose pins were emitted at the top level rather than inside a `<name>_1_1` unit
sub-symbol. KiCad's own parser accepts both and files them under unit 1 either
way (checked against `sch_io_kicad_sexpr_parser.cpp`), so that was never a
correctness bug, but it did mean third-party tooling saw an empty symbol. The
emitter now writes the unit the way KiCad does.

Usage: python3 kicad-oracle.py <path to .kicad_sym or .kicad_mod>
"""

import json
import sys

try:
    from kiutils.symbol import SymbolLib
    from kiutils.footprint import Footprint
except ImportError:  # pragma: no cover - reported to the caller as JSON
    print(json.dumps({"error": "kiutils is not installed; the KiCad oracle cannot run"}))
    sys.exit(2)


def describe_symbol(path):
    library = SymbolLib().from_file(path)
    return {
        "kind": "symbol",
        "symbolCount": len(library.symbols),
        "symbols": [
            {
                "name": symbol.entryName,
                "properties": {p.key: p.value for p in symbol.properties},
                "unitCount": len(symbol.units),
                "pins": [
                    {
                        "number": pin.number,
                        "name": pin.name,
                        "x": pin.position.X,
                        "y": pin.position.Y,
                        "angle": pin.position.angle,
                        "length": pin.length,
                        "electricalType": pin.electricalType,
                    }
                    for unit in symbol.units
                    for pin in unit.pins
                ],
                "graphicCount": sum(len(unit.graphicItems) for unit in symbol.units),
            }
            for symbol in library.symbols
        ],
    }


def describe_footprint(path):
    footprint = Footprint().from_file(path)
    return {
        "kind": "footprint",
        "name": footprint.entryName,
        "description": footprint.description,
        "pads": [
            {
                "number": pad.number,
                "type": pad.type,
                "shape": pad.shape,
                "x": pad.position.X,
                "y": pad.position.Y,
                "sizeX": pad.size.X,
                "sizeY": pad.size.Y,
                "layers": pad.layers,
            }
            for pad in footprint.pads
        ],
        "models": [model.path for model in footprint.models],
        "graphicLayers": sorted(
            {getattr(item, "layer", None) for item in footprint.graphicItems if getattr(item, "layer", None)}
        ),
        "graphicCount": len(footprint.graphicItems),
    }


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: kicad-oracle.py <path to .kicad_sym or .kicad_mod>"}))
        return 2

    path = sys.argv[1]
    try:
        if path.endswith(".kicad_sym"):
            result = describe_symbol(path)
        elif path.endswith(".kicad_mod"):
            result = describe_footprint(path)
        else:
            print(json.dumps({"error": f"unsupported file type: {path}"}))
            return 2
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
