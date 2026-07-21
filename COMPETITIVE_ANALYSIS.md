# scheMAGIC Competitive Analysis

scheMAGIC appears to be a locally installed desktop tool, not a browser-only service and not an EDA plugin. Its public site says the user enters a manufacturer part number, the app fetches the datasheet automatically, then uses LLM-assisted parsing to extract pin tables, package information, and electrical specs. The visible output is a complete KiCad-oriented component set: schematic symbol, PCB footprint, and associated 3D model, with review/editing before saving into the project directory.

## Publicly observable behavior

- Input: manufacturer part number entry, not raw PDF upload.
- Parsing: automatic datasheet fetch plus LLM-assisted extraction.
- Output: symbol, footprint, and 3D model.
- Export target: KiCad, with project-local files rather than a hosted library.
- Distribution: downloadable macOS and Windows app.
- Workflow: not described as a plugin or live EDA integration; it is a standalone app that writes files locally.
- Pricing clues: 3 free generations, then a subscription.

## Likely weak points

The public copy suggests scheMAGIC is optimized for parts it can identify from a manufacturer part number, then map to common datasheet patterns and footprint templates. That is a strong fit for mainstream commercial ICs, connectors, and passives, but it is more brittle for aerospace and radiation-hardened parts where package variants, pin naming, mechanical drawings, and qualification metadata are less standardized across vendors.

For a part like TI's LMP7704-SP, the likely failure modes are package and footprint inference rather than symbol extraction alone. Rad-hard datasheets often use less common package codes, suffixes, and mechanical drawings that do not cleanly match the library-first assumptions of a mainstream generator. 3D model generation is also a common weak point because uncommon packages frequently require custom body geometry and lead details that are not present in generic templates.

## Why Forge can differentiate

Forge's rad-hard focus is meaningful because it shifts the problem from "generate the easy common parts" to "support high-rel parts with explicit datasheet parsing and export validation." The MVP should therefore treat symbol, footprint, and STEP generation as first-class artifacts, expose radiation qualification fields in the parsed record, and fail loudly when the LMP7704-SP pipeline cannot be completed.