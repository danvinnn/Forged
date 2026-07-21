# Forge

Forge is a local, download-only vertical AI product for datasheet-to-CAD intake. The current app starts from a part number, searches the web for the datasheet PDF, parses the file, shows the extracted part record, and downloads a ZIP containing the generated asset files for manual import into an EDA tool.

## Current support

- Input: part number first, with optional manufacturer hint and PDF upload fallback.
- Parsed fields: part number, manufacturer, package type, pin count, pin table, package dimensions, and radiation qualification text when detected.
- Export formats: KiCad is the primary supported path. Altium and Cadence/OrCAD are exposed in the UI as documented intermediate bundles instead of native vendor library files.
- ZIP contents: symbol file, footprint file, a real STEP package-body solid, normalized JSON, and a manifest.

## Known limitations

- STEP export currently generates the package body enclosure only; pin-lead geometry is still approximate.
- Native Altium and Cadence/OrCAD library generation is not complete yet, but the bundle no longer labels the intermediate symbol and footprint files as KiCad when those targets are selected.
- PDF parsing is text-extraction based and will be weaker on scanned PDFs or datasheets with heavily image-based pin tables.
- Mechanical package inference is heuristic and still needs validation against more part families.

## Validation

Primary validation target: TI LMP7704-SP.

The public TI product page exposes the datasheet, radiation reports, package information, and a 14-pin CFP/HBH ordering record. Forge is designed to extract those fields into the normalized part record and to surface the rad-hard metadata in the UI even if it is not yet used by every generator.

## Run locally

1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Enter a part number, let Forge find the datasheet, review the parsed record, choose an export format, and download the ZIP.

## TODO

- Add native Altium and Cadence/OrCAD library emitters.
- Expand the pin-table parser for more vendor-specific datasheet layouts.
- Add regression tests for LMP7704-SP and a few representative commercial packages.