import JSZip from "jszip";
import { type ExportFormat, type PartRecord, type PinRecord } from "./types";

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "part";
}

function formatStepNumber(value: number): string {
  const formatted = Number.isInteger(value) ? value.toFixed(1) : value.toFixed(6);
  return formatted.replace(/\.0+$/, ".").replace(/(\.\d*?)0+$/, "$1");
}

function stepPoint(x: number, y: number, z: number): string {
  return `(${formatStepNumber(x)},${formatStepNumber(y)},${formatStepNumber(z)})`;
}

function buildStepModel(part: PartRecord): { content: string; note: string; supported: boolean; fileName: string } {
  const lengthMm = part.dimensions.bodyLengthMm ?? Math.max(part.pinCount * 0.8, 4.0);
  const widthMm = part.dimensions.bodyWidthMm ?? Math.max(part.pinCount * 0.55, 3.0);
  const heightMm = part.dimensions.bodyHeightMm ?? 1.5;
  const halfLength = lengthMm / 2;
  const halfWidth = widthMm / 2;
  const halfHeight = heightMm / 2;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  const points = [
    [-halfLength, -halfWidth, -halfHeight],
    [halfLength, -halfWidth, -halfHeight],
    [halfLength, halfWidth, -halfHeight],
    [-halfLength, halfWidth, -halfHeight],
    [-halfLength, -halfWidth, halfHeight],
    [halfLength, -halfWidth, halfHeight],
    [halfLength, halfWidth, halfHeight],
    [-halfLength, halfWidth, halfHeight]
  ] as const;

  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('Forge generated STEP package body for ${part.partNumber}'),'2;1');`,
    `FILE_NAME('${part.partNumber}.step','${now}',('Forge'),('Forge'),'Forge MVP','Forge','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    "#1=APPLICATION_CONTEXT('mechanical design');",
    "#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2001,#1);",
    "#3=PRODUCT_CONTEXT('',#1,'mechanical');",
    `#4=PRODUCT('${part.partNumber}','${part.partNumber} package body','',(#3));`,
    "#5=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('1',$,#4,.MADE.);",
    "#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
    "#7=PRODUCT_DEFINITION('design',$,#5,#6);",
    "#8=PRODUCT_DEFINITION_SHAPE('',$,#7);",
    "#9=GEOMETRIC_REPRESENTATION_CONTEXT(3);"
  ];

  points.forEach((point, index) => {
    const pointId = index + 10;
    const vertexId = index + 20;
    lines.push(`#${pointId}=CARTESIAN_POINT('',${stepPoint(point[0], point[1], point[2])});`);
    lines.push(`#${vertexId}=VERTEX_POINT('',#${pointId});`);
  });

  const edges = [
    { id: 30, start: 20, end: 21, direction: [1, 0, 0], length: lengthMm },
    { id: 31, start: 21, end: 22, direction: [0, 1, 0], length: widthMm },
    { id: 32, start: 22, end: 23, direction: [-1, 0, 0], length: lengthMm },
    { id: 33, start: 23, end: 20, direction: [0, -1, 0], length: widthMm },
    { id: 34, start: 24, end: 25, direction: [1, 0, 0], length: lengthMm },
    { id: 35, start: 25, end: 26, direction: [0, 1, 0], length: widthMm },
    { id: 36, start: 26, end: 27, direction: [-1, 0, 0], length: lengthMm },
    { id: 37, start: 27, end: 24, direction: [0, -1, 0], length: widthMm },
    { id: 38, start: 20, end: 24, direction: [0, 0, 1], length: heightMm },
    { id: 39, start: 21, end: 25, direction: [0, 0, 1], length: heightMm },
    { id: 40, start: 22, end: 26, direction: [0, 0, 1], length: heightMm },
    { id: 41, start: 23, end: 27, direction: [0, 0, 1], length: heightMm }
  ];

  edges.forEach((edge) => {
    const lineId = edge.id + 100;
    const directionId = edge.id + 200;
    const vectorId = edge.id + 300;
    lines.push(`#${directionId}=DIRECTION('',(${formatStepNumber(edge.direction[0])},${formatStepNumber(edge.direction[1])},${formatStepNumber(edge.direction[2])}));`);
    lines.push(`#${vectorId}=VECTOR('',#${directionId},${formatStepNumber(edge.length)});`);
    lines.push(`#${lineId}=LINE('',#${edge.start},#${vectorId});`);
    lines.push(`#${edge.id}=EDGE_CURVE('',#${edge.start},#${edge.end},#${lineId},.T.);`);
  });

  const faces = [
    { id: 60, origin: stepPoint(0, 0, -halfHeight), normal: [0, 0, -1], reference: [1, 0, 0], loop: [33, 32, 31, 30] },
    { id: 61, origin: stepPoint(0, 0, halfHeight), normal: [0, 0, 1], reference: [1, 0, 0], loop: [34, 35, 36, 37] },
    { id: 62, origin: stepPoint(0, -halfWidth, 0), normal: [0, -1, 0], reference: [1, 0, 0], loop: [30, 39, 34, 38] },
    { id: 63, origin: stepPoint(0, halfWidth, 0), normal: [0, 1, 0], reference: [1, 0, 0], loop: [32, 41, 36, 40] },
    { id: 64, origin: stepPoint(-halfLength, 0, 0), normal: [-1, 0, 0], reference: [0, 1, 0], loop: [33, 40, 37, 38] },
    { id: 65, origin: stepPoint(halfLength, 0, 0), normal: [1, 0, 0], reference: [0, 1, 0], loop: [31, 39, 35, 41] }
  ];

  faces.forEach((face) => {
    const locationId = face.id + 100;
    const normalId = face.id + 200;
    const referenceId = face.id + 210;
    const axisId = face.id + 220;
    const planeId = face.id + 230;
    const loopId = face.id + 240;
    const boundId = face.id + 250;

    lines.push(`#${locationId}=CARTESIAN_POINT('',${face.origin});`);
    lines.push(`#${normalId}=DIRECTION('',(${formatStepNumber(face.normal[0])},${formatStepNumber(face.normal[1])},${formatStepNumber(face.normal[2])}));`);
    lines.push(`#${referenceId}=DIRECTION('',(${formatStepNumber(face.reference[0])},${formatStepNumber(face.reference[1])},${formatStepNumber(face.reference[2])}));`);
    lines.push(`#${axisId}=AXIS2_PLACEMENT_3D('',#${locationId},#${normalId},#${referenceId});`);
    lines.push(`#${planeId}=PLANE('',#${axisId});`);
    lines.push(`#${loopId}=EDGE_LOOP('',(${face.loop.map((edgeId) => `#${edgeId}`).join(",")}));`);
    lines.push(`#${boundId}=FACE_OUTER_BOUND('',#${loopId},.T.);`);
    lines.push(`#${face.id}=ADVANCED_FACE('',(#${boundId}),#${planeId},.T.);`);
  });

  lines.push("#70=CLOSED_SHELL('',(#60,#61,#62,#63,#64,#65));");
  lines.push("#71=MANIFOLD_SOLID_BREP('PackageBody',#70);");
  lines.push("#72=ADVANCED_BREP_SHAPE_REPRESENTATION('NONE',(#71),#9);");
  lines.push("#73=SHAPE_DEFINITION_REPRESENTATION(#8,#72);");
  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");

  return {
    content: lines.join("\n"),
    note: `Generated a real STEP Part 21 solid for ${part.partNumber}. The model is a simplified package body enclosure based on extracted body dimensions.`,
    supported: true,
    fileName: `${slugify(part.partNumber)}.step`
  };
}

function kicadPinType(pinType: PinRecord["electricalType"]): string {
  switch (pinType) {
    case "power":
      return "power_in";
    case "input":
      return "input";
    case "output":
      return "output";
    case "bidirectional":
      return "bidirectional";
    case "passive":
      return "passive";
    case "nc":
      return "not_connected";
    default:
      return "unspecified";
  }
}

function buildSymbol(part: PartRecord): string {
  const symbolName = part.partNumber;
  const pinCount = Math.max(part.pins.length, part.pinCount);
  const leftPins = part.pins.filter((pin) => ["input", "power", "passive", "unspecified"].includes(pin.electricalType));
  const rightPins = part.pins.filter((pin) => pin.electricalType === "output");
  const fallbackPins = part.pins.filter((pin) => !leftPins.includes(pin) && !rightPins.includes(pin));
  const canvasHeight = Math.max(pinCount, 4) * 2.54;

  const pins = [...leftPins, ...fallbackPins, ...rightPins];
  const pinLines = pins.length > 0 ? pins : part.pins;

  const lines = [
    "(kicad_symbol_lib",
    "  (version 20211014)",
    "  (generator Forge)",
    `  (symbol \"${symbolName}\"`,
    "    (pin_names (offset 0.508))",
    "    (in_bom yes)",
    "    (on_board yes)",
    `    (property \"Reference\" \"U\" (at 0 0 0) (effects (font (size 1.27 1.27))))`,
    `    (property \"Value\" \"${symbolName}\" (at 0 ${(-canvasHeight / 2 - 2.54).toFixed(2)} 0) (effects (font (size 1.27 1.27))))`,
    `    (rectangle (start -5.08 ${canvasHeight / 2}) (end 5.08 ${-canvasHeight / 2}) (stroke (width 0.254) (type solid)) (fill (type background)))`
  ];

  const leftStart = canvasHeight / 2 - 2.54;
  const rightStart = canvasHeight / 2 - 2.54;
  pinLines.forEach((pin, index) => {
    const isOutput = pin.electricalType === "output";
    const x = isOutput ? 7.62 : -7.62;
    const angle = isOutput ? 180 : 0;
    const y = (isOutput ? rightStart : leftStart) - index * 2.54;
    lines.push(`    (pin ${kicadPinType(pin.electricalType)} line (at ${x.toFixed(2)} ${y.toFixed(2)} ${angle}) (length 2.54) (name \"${pin.name}\" (effects (font (size 1.0 1.0)))) (number \"${pin.number}\" (effects (font (size 1.0 1.0)))))`);
  });

  lines.push("  )", ")");
  return lines.join("\n");
}

function buildFootprint(part: PartRecord): string {
  const pinCount = Math.max(part.pins.length, part.pinCount);
  const packageType = part.packageType.toUpperCase();
  const isPerimeterPackage = /CFP|QFP|LQFP|TQFP|SOP|SOIC|QFN|DFN|SON|LCC|CLCC|CERAMIC|FLAT PACK|HBH/.test(packageType);
  const pitch = part.dimensions.pitchMm ?? 1.27;
  const bodyLength = part.dimensions.bodyLengthMm ?? Math.max(pitch * Math.ceil(pinCount / 2) + 2.5, 6.0);
  const bodyWidth = part.dimensions.bodyWidthMm ?? Math.max(pitch * Math.ceil(pinCount / 2) + 2.5, 6.0);
  const padLength = Math.max((part.dimensions.leadLengthMm ?? 1.5) + 0.6, 1.2);
  const padWidth = Math.max(pitch * 0.55, 0.6);
  const bodyHalfX = bodyLength / 2;
  const bodyHalfY = bodyWidth / 2;
  const padOffset = Math.max(bodyHalfX + padLength / 2 + 0.25, bodyHalfY + padLength / 2 + 0.25);
  const symbolName = `${slugify(part.partNumber)}-${slugify(part.packageType)}`;

  const lines = [
    `(footprint \"${symbolName}\"`,
    `  (version 20240108)`,
    `  (generator Forge)`,
    `  (layer \"F.Cu\")`,
    `  (descr \"Generated footprint for ${part.partNumber}\")`,
    `  (property \"Reference\" \"U\" (at 0 ${-(bodyHalfY + 1.8).toFixed(2)} 0) (layer \"F.SilkS\") (effects (font (size 1 1))))`,
    `  (property \"Value\" \"${part.partNumber}\" (at 0 ${(bodyHalfY + 1.8).toFixed(2)} 0) (layer \"F.Fab\") (effects (font (size 1 1))))`,
    `  (fp_line (start ${(-bodyHalfX).toFixed(2)} ${(-bodyHalfY).toFixed(2)}) (end ${bodyHalfX.toFixed(2)} ${(-bodyHalfY).toFixed(2)}) (layer \"F.Fab\") (width 0.1))`,
    `  (fp_line (start ${bodyHalfX.toFixed(2)} ${(-bodyHalfY).toFixed(2)}) (end ${bodyHalfX.toFixed(2)} ${bodyHalfY.toFixed(2)}) (layer \"F.Fab\") (width 0.1))`,
    `  (fp_line (start ${bodyHalfX.toFixed(2)} ${bodyHalfY.toFixed(2)}) (end ${(-bodyHalfX).toFixed(2)} ${bodyHalfY.toFixed(2)}) (layer \"F.Fab\") (width 0.1))`,
    `  (fp_line (start ${(-bodyHalfX).toFixed(2)} ${bodyHalfY.toFixed(2)}) (end ${(-bodyHalfX).toFixed(2)} ${(-bodyHalfY).toFixed(2)}) (layer \"F.Fab\") (width 0.1))`,
    `  (fp_text user \"${part.packageType}\" (at 0 0 0) (layer \"F.Fab\") (effects (font (size 0.8 0.8))))`
  ];

  if (isPerimeterPackage) {
    const sidePad = (count: number, constant: number, axis: "x" | "y", startIndex: number) => {
      const span = Math.max((count - 1) * pitch, 0);
      const first = -span / 2;
      for (let index = 0; index < count; index += 1) {
        const position = first + index * pitch;
        const padNumber = startIndex + index;
        const x = axis === "x" ? position : constant;
        const y = axis === "y" ? position : constant;
        const rotation = axis === "x" ? 90 : 0;
        lines.push(`  (pad \"${padNumber}\" smd roundrect (at ${x.toFixed(2)} ${y.toFixed(2)} ${rotation}) (size ${padLength.toFixed(2)} ${padWidth.toFixed(2)}) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (roundrect_rratio 0.18))`);
      }
      return startIndex + count;
    };

    const sideCounts = {
      top: Math.ceil(pinCount / 4),
      right: Math.ceil((pinCount - Math.ceil(pinCount / 4)) / 3),
      bottom: Math.ceil((pinCount - Math.ceil(pinCount / 4) - Math.ceil((pinCount - Math.ceil(pinCount / 4)) / 3)) / 2)
    };

    let nextPin = 1;
    nextPin = sidePad(sideCounts.top, padOffset, "x", nextPin);
    nextPin = sidePad(sideCounts.right, padOffset, "y", nextPin);
    nextPin = sidePad(sideCounts.bottom, -padOffset, "x", nextPin);
    sidePad(Math.max(pinCount - nextPin + 1, 0), -padOffset, "y", nextPin);
  } else {
    const pinsPerSide = Math.ceil(pinCount / 2);
    const span = Math.max((pinsPerSide - 1) * pitch, 0);
    const first = -span / 2;
    for (let index = 0; index < pinsPerSide; index += 1) {
      const position = first + index * pitch;
      const leftPadNumber = index + 1;
      const rightPadNumber = index + 1 + pinsPerSide;
      lines.push(`  (pad \"${leftPadNumber}\" smd roundrect (at ${(-padOffset).toFixed(2)} ${position.toFixed(2)} 90) (size ${padLength.toFixed(2)} ${padWidth.toFixed(2)}) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (roundrect_rratio 0.18))`);
      if (rightPadNumber <= pinCount) {
        lines.push(`  (pad \"${rightPadNumber}\" smd roundrect (at ${padOffset.toFixed(2)} ${position.toFixed(2)} 90) (size ${padLength.toFixed(2)} ${padWidth.toFixed(2)}) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (roundrect_rratio 0.18))`);
      }
    }
  }

  lines.push(`  (fp_text user \"Pin count: ${pinCount}\" (at 0 ${(bodyHalfY + 0.9).toFixed(2)} 0) (layer \"F.SilkS\") (effects (font (size 0.7 0.7))))`);
  lines.push(")");

  return lines.join("\n");
}

function buildExchangeArtifact(part: PartRecord, format: Exclude<ExportFormat, "kicad">, kind: "symbol" | "footprint", content: string): { name: string; content: string } {
  return {
    name: `${slugify(part.partNumber)}.${format}.${kind}.txt`,
    content: [
      `Forge exchange ${kind} source for ${format.toUpperCase()}.`,
      `This is not a native ${format} library file yet.`,
      "",
      content
    ].join("\n")
  };
}

export async function createExportZip(part: PartRecord, format: ExportFormat) {
  const zip = new JSZip();
  const baseName = slugify(part.partNumber);
  const stepModel = buildStepModel(part);
  const files: Array<{ name: string; content: string }> = [];

  if (format === "kicad") {
    files.push({ name: `${baseName}.kicad_sym`, content: buildSymbol(part) });
    files.push({ name: `${baseName}.kicad_mod`, content: buildFootprint(part) });
  } else {
    files.push(buildExchangeArtifact(part, format, "symbol", buildSymbol(part)));
    files.push(buildExchangeArtifact(part, format, "footprint", buildFootprint(part)));
    files.push({
      name: "EXPORT_NOTES.txt",
      content: `Native ${format} export is not implemented in this MVP. The ZIP contains vendor-neutral exchange artifacts and a normalized JSON record that can be mapped to ${format} later.`
    });
  }

  files.push({ name: stepModel.fileName, content: stepModel.content });
  files.push({
    name: `${baseName}.json`,
    content: JSON.stringify({ ...part, exportFormat: format, stepSupported: stepModel.supported, stepNote: stepModel.note }, null, 2)
  });

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        partNumber: part.partNumber,
        manufacturer: part.manufacturer,
        exportFormat: format,
        generatedAt: new Date().toISOString(),
        files: files.map((file) => file.name)
      },
      null,
      2
    )
  );

  for (const file of files) {
    zip.file(file.name, file.content);
  }

  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    stepSupported: stepModel.supported,
    stepNote: stepModel.note,
    files: files.map((file) => file.name)
  };
}