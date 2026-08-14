"use client";

import { useEffect, useMemo, useState } from "react";
import { isUntraceable } from "../lib/provenance";
import type { Extracted, ExportFormat, LeadWidth, PartRecord, PinRecord } from "../lib/types";
// Type-only import: erased at compile time, so no retrieval-layer runtime code (node:crypto,
// the resolvers, etc.) is pulled into the client bundle.
import type { DeploymentMode } from "../lib/retrieval";
// Type-only for the same reason: `exporters.ts` reaches the CAD generators.
import type { PackageChoice, RequiredInput } from "../lib/exporters";
import type { ReviewItem } from "../lib/review";
// Type-only: `pagerender.ts` dynamically imports mupdf, which must not follow
// the review panel into the browser bundle.
import type { RenderedPage } from "../lib/pagerender";

interface AppConfig {
  mode: DeploymentMode;
  lookupEnabled: boolean;
  /** Package families with a characterised IPC-7351B land pattern. */
  packageFamilies?: string[];
}

/**
 * Quick picks for the package field.
 *
 * A datasheet almost always offers a part in several packages, and a footprint
 * is per package, so this is a choice the engineer makes rather than something
 * extraction can settle. Export refuses any package with no characterised land
 * pattern, and without these the only way to discover which ones work is to
 * press Export and read the error.
 */
const PACKAGE_SUGGESTIONS: Record<string, string[]> = {
  "SOIC narrow": ["SOIC-8", "SOIC-14", "SOIC-16"],
  TSSOP: ["TSSOP-8", "TSSOP-14", "TSSOP-16"]
};

const formatOptions: Array<{ value: ExportFormat; label: string; note: string }> = [
  { value: "kicad", label: "KiCad", note: "Native .kicad_sym + .kicad_mod" },
  // Each format gets its own generator reading the same IPC-7351B geometry.
  // These two say "no generator yet" rather than offering a renamed KiCad file,
  // which is what they used to do.
  { value: "altium", label: "Altium", note: "Native .SchLib + .PcbLib, generator not built yet" },
  { value: "cadence", label: "Cadence / OrCAD", note: "Native library output, generator not built yet" }
]

const nothing = <T,>(): Extracted<T> => ({ value: null, confidence: null, method: null, citation: null });

const defaultPart: PartRecord = {
  id: "",
  partNumber: nothing<string>(),
  manufacturer: nothing<string>(),
  packageType: nothing<string>(),
  packageOutlineCode: nothing<string>(),
  jedecOutline: nothing<string>(),
  packageVariants: [],
  vendorLandPattern: null,
  exposedPad: false,
  conflicts: [],
  pinCount: nothing<number>(),
  pins: nothing<PinRecord[]>(),
  dimensions: {
    bodyLengthMm: nothing<number>(),
    bodyWidthMm: nothing<number>(),
    bodyHeightMm: nothing<number>(),
    pitchMm: nothing<number>(),
    leadLengthMm: nothing<number>(),
    leadCount: nothing<number>(),
    leadWidthMm: nothing<LeadWidth>(),
    leadSpanMm: nothing<LeadWidth>(), leadContactMm: nothing<LeadWidth>(),
    thermalPadLengthMm: nothing<number>(),
    thermalPadWidthMm: nothing<number>(),
    landPadLengthMm: nothing<number>(),
    landPadWidthMm: nothing<number>(),
    landSpanMm: nothing<number>(),
    leadSides: nothing<2 | 4>(),
    leadForm: nothing<"gullwing" | "nolead">(),
    vacantLeadSlot: nothing<number>(),
    solderMaskExpansionMm: nothing<number>(),
    solderMaskDefined: nothing<"solder-mask-defined" | "non-solder-mask-defined">(),
    thermalViaDiameterMm: nothing<number>(),
    thermalViaPitchMm: nothing<number>()
  },
  radiation: {
    tid: nothing<string>(),
    see: nothing<string>(),
    sel: nothing<string>(),
    qmlClass: nothing<string>()
  },
  sourceFileName: "",
  notes: []
};

/**
 * A hand-entered value is fully trusted but has no citation, and must never
 * keep the parser's provenance. Editing a field is a change of method.
 */
function userEdited<T>(value: T | null): Extracted<T> {
  return { value, confidence: value === null ? null : 1, method: value === null ? null : "user", citation: null };
}

/** Renders provenance compactly: where it came from and how sure we are. */
function Provenance({ field }: { field: Extracted<unknown> }) {
  if (field.value === null) {
    return <span className="prov prov-unknown">not found in datasheet</span>;
  }
  if (isUntraceable(field)) {
    return (
      <span className="prov prov-untraceable" title="Produced by an extraction model but not located in the datasheet. Verify it against the source, then edit the field to confirm.">
        unverified · needs review
      </span>
    );
  }
  const parts: string[] = [];
  if (field.citation) parts.push(`p${field.citation.page}`);
  // A person typing a value and a person confirming a model's reading against
  // the cited page are different claims, and the badge says which.
  if (field.method === "user") parts.push("entered by you");
  else if (field.method === "user-confirmed") parts.push("checked by you");
  else if (field.method) parts.push(field.method);
  if (field.confidence !== null) parts.push(`${Math.round(field.confidence * 100)}%`);
  return (
    <span className="prov" title={field.citation?.snippet ?? undefined}>
      {parts.join(" · ")}
    </span>
  );
}

/** A value plus its provenance, for the read-only tables. */
function Cell({ field }: { field: Extracted<string | number> }) {
  return (
    <>
      <td>{field.value ?? "not found"}</td>
      <td>
        <Provenance field={field} />
      </td>
    </>
  );
}

function clonePart(part: PartRecord): PartRecord {
  return JSON.parse(JSON.stringify(part)) as PartRecord;
}

function updatePin(part: PartRecord, index: number, field: keyof PinRecord, value: string) {
  const next = clonePart(part);
  const pins = next.pins.value;
  const pin = pins?.[index];
  if (!pins || !pin) return next;

  if (field === "electricalType") {
    pin.electricalType = value as PinRecord["electricalType"];
  } else if (field === "number" || field === "name") {
    pin[field] = value;
  }

  // The table was edited by hand, so the array's provenance changes with it.
  next.pins = { value: pins, confidence: 1, method: "user", citation: next.pins.citation };
  return next;
}

function formatSourceUrl(sourceUrl?: string) {
  if (!sourceUrl) {
    return null;
  }

  try {
    const parsed = new URL(sourceUrl);
    // new URL() happily parses "javascript:..." and "data:...", and this value ends up as an
    // anchor href. Our URLs come from the SSRF-guarded fetch path so they are already http(s),
    // but this is the last hop before the DOM and the check is one line, so enforce it here too
    // rather than relying on an invariant held three layers away.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Where an `install`-scoped answer is remembered.
 *
 * Deliberately survives the session. Asking an assembler for their formed lead
 * span once a week is a different product from asking them once per part, and
 * the route already marks which answers are which.
 */
const INSTALL_LEAD_SPAN_KEY = "forge.install.formedLeadSpanMm";

/** Largest span the export route accepts, mirrored so the UI refuses it first. */
const MAX_LEAD_SPAN_MM = 200;

/**
 * What a package choice actually produced, said plainly.
 *
 * A choice that resolves a pinout and a choice that changes nothing look
 * identical in the record unless the difference is stated, and the second is a
 * real outcome: the document may simply not draw a pinout for that package. The
 * user needs to know which happened so they can try another chip rather than
 * assume the tool is broken.
 */
function describeChoice(record: PartRecord, designator: string): string {
  const pins = record.pins.value?.length ?? 0;
  if (pins > 0 && record.pinCount.value !== null) {
    return `Read ${pins} pins for ${designator}. Review fields before export.`;
  }
  if (pins > 0) {
    return `Found ${pins} pins for ${designator}, but nothing in the datasheet confirms the count, so it is left unknown.`;
  }
  return `No pinout found for ${designator} in this datasheet. Try another package, or enter the pins by hand.`;
}

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [partPrompt, setPartPrompt] = useState("");
  const [manufacturerHint, setManufacturerHint] = useState("");
  const [part, setPart] = useState<PartRecord>(defaultPart);

  // How the current record was produced, so a package choice can be answered by
  // PARSING AGAIN with that package rather than by writing it into the record.
  //
  // The distinction is the whole point. Every pin reader takes the package as an
  // argument and uses it to choose among a document's per-package pinouts, so a
  // package that arrives after the parse arrives too late to be used: the record
  // gains a package name and keeps the empty pinout it already had. Measured on
  // unseen datasheets, re-parsing turns five refusals into complete records.
  const [origin, setOrigin] = useState<
    { kind: "upload"; file: File } | { kind: "lookup"; partNumber: string; manufacturer: string } | null
  >(null);

  // The packages the document offered, held separately from the record because
  // the record's own list is filtered against the pin count it settled on. Once
  // a choice resolves that count, the alternatives would disappear from the
  // record and the user could not change their mind.
  const [offeredVariants, setOfferedVariants] = useState<PartRecord["packageVariants"]>([]);

  // What each offered package would actually produce, from the server, which
  // runs the real footprint generator to find out. Held on the same terms as
  // `offeredVariants`: the first read's answer, kept across a re-read so a user
  // who picks one package can still see what the others would have done.
  const [packageChoice, setPackageChoice] = useState<PackageChoice | null>(null);

  // Values the export asked for that no datasheet carries. Empty unless the last
  // export came back 422 INPUT_REQUIRED.
  const [pendingNeeds, setPendingNeeds] = useState<RequiredInput[]>([]);
  const [needValue, setNeedValue] = useState("");
  /**
   * Values the record holds but nobody has checked, with the pages to check them
   * on. This is the rung of the friction ladder between "nothing to do" and
   * "type a number": we already have an answer, it just needs one second of a
   * human's attention before anyone signs for it.
   */
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [reviewPageImages, setReviewPageImages] = useState<RenderedPage[]>([]);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");

  // An `install`-scoped answer is a property of the assembly line, not of the
  // part: the trim an assembler forms leads to is the same for an op-amp and a
  // microcontroller. So it is asked ONCE and remembered, which is what makes it
  // a one-time cost rather than a per-part tax. A `part`-scoped answer is never
  // stored, because reusing one across parts would be a guess.
  const [installLeadSpan, setInstallLeadSpan] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(INSTALL_LEAD_SPAN_KEY);
      const parsed = saved === null ? NaN : Number(saved);
      if (Number.isFinite(parsed) && parsed > 0) setInstallLeadSpan(parsed);
    } catch {
      // A blocked or full localStorage costs the user one re-entry, not the export.
    }
  }, []);
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("kicad");
  const [status, setStatus] = useState("Loading workspace...");
  const [busy, setBusy] = useState(false);

  // Deployment mode surfaced by GET /api/config. Stays null while loading so the lookup box
  // never flashes on screen before we know whether it is allowed. The server 403 on
  // /api/lookup remains the real gate; this only decides which UI to render.
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: AppConfig) => {
        if (cancelled) return;
        setConfig(data);
        setStatus(
          data.lookupEnabled
            ? "Enter a part number, or upload a datasheet PDF."
            : "Air-gapped mode: upload a datasheet PDF to begin."
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Config is UX only and the server gate still holds, but fail closed here to match the
        // server's production default: if the mode cannot be confirmed, assume no network and
        // show upload only rather than offering a lookup that would just 403.
        setConfig({ mode: "air-gapped", lookupEnabled: false });
        setStatus("Could not confirm deployment mode. Upload a datasheet PDF to begin.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dimensionsRows = useMemo(
    (): Array<[string, Extracted<number>]> => [
      ["Body length", part.dimensions.bodyLengthMm],
      ["Body width", part.dimensions.bodyWidthMm],
      ["Body height", part.dimensions.bodyHeightMm],
      ["Pitch", part.dimensions.pitchMm],
      ["Lead length", part.dimensions.leadLengthMm],
      ["Lead count", part.dimensions.leadCount]
    ],
    [part.dimensions]
  );

  const sourceUrl = formatSourceUrl(part.sourceUrl);

  // The packages to offer: those the first read found, falling back to the
  // record's own list so a record that arrived some other way still gets a
  // chooser. Held apart from the record because choosing narrows the record's
  // copy, and a user who picks wrong has to be able to pick again.
  const packageChoices =
    offeredVariants.length > 0 ? offeredVariants : part.packageVariants;
  // What each chip will do, keyed by the designator printed on it. Empty when
  // the record could not resolve at all, in which case the chips carry no
  // outcome rather than a wrong one: see the note on the picker below.
  const packageOutcomes = new Map(
    packageChoice?.ok ? packageChoice.options.map((option) => [option.designator, option]) : []
  );
  // Flattened from the families the server says it can build, so the list can
  // never drift from what export actually accepts.
  const supportedPackages = (config?.packageFamilies ?? []).flatMap(
    (family) => PACKAGE_SUGGESTIONS[family] ?? []
  );

  async function handleLookup(options?: { partNumber?: string; manufacturer?: string; packageType?: string }) {
    const trimmedPart = (options?.partNumber ?? partPrompt).trim();
    if (!trimmedPart) {
      setStatus("Enter a part number first.");
      return;
    }
    const trimmedManufacturer = (options?.manufacturer ?? manufacturerHint).trim();

    setBusy(true);
    setStatus(
      options?.packageType
        ? `Re-reading the datasheet for ${trimmedPart} as ${options.packageType}...`
        : `Resolving the datasheet for ${trimmedPart}...`
    );

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        // Optional fields are OMITTED when blank rather than sent empty. The
        // schema requires a non-empty string when the key is present, so sending
        // `manufacturer: ""` failed the whole request and came back as
        // "Part number is required" on every lookup made without a hint.
        body: JSON.stringify({
          partNumber: trimmedPart,
          ...(trimmedManufacturer ? { manufacturer: trimmedManufacturer } : {}),
          ...(options?.packageType ? { packageType: options.packageType } : {})
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Failed to find the datasheet.");
      }

      const record = payload.part as PartRecord;
      setPart(record);
      setSelectedFile(null);
      setOrigin({ kind: "lookup", partNumber: trimmedPart, manufacturer: trimmedManufacturer });
      // A re-read keeps the packages the first read offered; see `offeredVariants`.
      if (!options?.packageType) setOfferedVariants(record.packageVariants);
      setStatus(
        options?.packageType
          ? describeChoice(record, options.packageType)
          : `Found the datasheet PDF for ${trimmedPart}. Review the record before export.`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected lookup failure.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  async function handlePromptSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleLookup();
  }

  async function handleFile(file: File | null, packageType?: string) {
    setSelectedFile(file);
    if (!file) return;

    setBusy(true);
    setStatus(packageType ? `Re-reading ${file.name} as ${packageType}...` : `Parsing ${file.name}...`);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (packageType) formData.append("packageType", packageType);

      const response = await fetch("/api/parse", { method: "POST", body: formData });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Failed to parse datasheet.");
      }

      const record = payload.part as PartRecord;
      setPart(record);
      setReview((payload.review as ReviewItem[]) ?? []);
      setReviewPageImages((payload.reviewPages as RenderedPage[]) ?? []);
      setOpenReview(null);
      setOrigin({ kind: "upload", file });
      // A re-read keeps the packages the first read offered; see `offeredVariants`.
      if (!packageType) {
        setOfferedVariants(record.packageVariants);
        setPackageChoice((payload.packageChoice as PackageChoice) ?? null);
      }
      setStatus(
        packageType
          ? describeChoice(record, packageType)
          : `Parsed ${record.partNumber.value ?? file.name}. Review fields before export.`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected parse failure.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Answers a package choice by reading the datasheet AGAIN with that package.
   *
   * Two cases do NOT re-read.
   *
   * The source document is no longer to hand, which is the pre-existing
   * behaviour and all that is possible then: the readers cannot re-run without
   * the bytes.
   *
   * Or the record is already complete, meaning it has pins AND a settled count.
   * A re-read can only take that away, since the readers may find nothing for
   * the newly named package, and losing a working pinout is a worse outcome than
   * any it could win. A complete record is one the user can already export, so
   * the click means "label it this" and is honoured as written. The incomplete
   * case is the one worth re-reading, and it is also the only one measured to
   * gain: all five hold-out parts a choice rescues have no pinout at all.
   */
  async function handlePackageChoice(designator: string) {
    const alreadyComplete = (part.pins.value?.length ?? 0) > 0 && part.pinCount.value !== null;
    if (alreadyComplete) {
      setPart({ ...part, packageType: userEdited(designator) });
      setStatus(`Package set to ${designator}. The pinout already read, so it was left as it is.`);
      return;
    }

    if (origin?.kind === "upload") {
      await handleFile(origin.file, designator);
      return;
    }
    if (origin?.kind === "lookup") {
      await handleLookup({
        partNumber: origin.partNumber,
        manufacturer: origin.manufacturer,
        packageType: designator
      });
      return;
    }
    setPart({ ...part, packageType: userEdited(designator) });
  }

  /**
   * Builds the bundle, supplying any value the datasheet cannot carry.
   *
   * `formedLeadSpan` is passed explicitly rather than read from state because a
   * React state update is not visible to the handler that queued it, and the
   * whole point of the flow is to answer the 422 and immediately retry.
   */
  async function handleExport(formedLeadSpan?: number) {
    setBusy(true);
    setStatus(`Building ${selectedFormat.toUpperCase()} export bundle...`);

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          part,
          format: selectedFormat,
          ...(formedLeadSpan !== undefined ? { formedLeadSpanMm: formedLeadSpan } : {})
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);

        // A refusal the user can ANSWER, which is a different thing from a
        // refusal they cannot. `needs` populated means the footprint is one
        // number away and that number is a property of their assembly line, not
        // of the datasheet; the route has always said so and the UI used to
        // flatten it into an error string, which left the value unreachable and
        // the parts unexportable. Empty `needs` is a package Forge has not
        // characterised, which is ours to fix and not something to prompt about.
        if (payload?.code === "INPUT_REQUIRED" && Array.isArray(payload.needs) && payload.needs.length > 0) {
          setPendingNeeds(payload.needs as RequiredInput[]);
          setStatus(payload.error || "One more value is needed to build the footprint.");
          return;
        }
        throw new Error(payload?.error || "Export failed.");
      }

      setPendingNeeds([]);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${part.partNumber.value || "forge-part"}-forge.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);

      const stepSupported = response.headers.get("X-Forge-Step-Supported") === "true";
      const stepNote = response.headers.get("X-Forge-Step-Note") || "";
      const exportNote = response.headers.get("X-Forge-Export-Note") || "";
      setStatus(stepSupported ? `ZIP downloaded. ${exportNote}`.trim() : `ZIP downloaded. ${stepNote || exportNote}`.trim());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected export failure.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Answers the export's outstanding request and retries immediately.
   *
   * The retry is the point. Handing back a value and then making the user find
   * the download button again is the same friction the prompt was added to
   * remove.
   */
  /**
   * Writes one field back into the record by its dotted path.
   *
   * Only the field named is touched, and only its own keys: a confirmation must
   * never disturb a neighbouring value or the citation the reviewer just read.
   */
  function withField(record: PartRecord, path: string, patch: Partial<Extracted<unknown>>): PartRecord {
    if (!path.includes(".")) {
      const current = (record as unknown as Record<string, Extracted<unknown>>)[path];
      return { ...record, [path]: { ...current, ...patch } } as PartRecord;
    }
    const [group, key] = path.split(".");
    const bag = (record as unknown as Record<string, Record<string, Extracted<unknown>>>)[group];
    return {
      ...record,
      [group]: { ...bag, [key]: { ...bag[key], ...patch } }
    } as PartRecord;
  }

  /** Drops an item once a person has dealt with it. */
  function settle(field: string) {
    setReview((items) => items.filter((item) => item.field !== field));
    setOpenReview(null);
    setCorrection("");
  }

  /**
   * "I looked at the page and this is right."
   *
   * Recorded as `user-confirmed` rather than `user`, and the citation is KEPT.
   * The value still came off page 2 and a reviewer auditing this later should
   * see both facts: a model read it, and a person checked it against the page it
   * claims. That is a stronger record than either alone, and it is also what
   * unblocks an export: an uncited model value cannot pass `resolveForExport`,
   * and a confirmed one can.
   */
  function handleConfirmReview(item: ReviewItem) {
    setPart((record) =>
      withField(record, item.field, { confidence: 1, method: "user-confirmed" })
    );
    settle(item.field);
    setStatus(`Confirmed ${item.label.toLowerCase()} against page ${item.page ?? "?"}.`);
  }

  /**
   * "I looked at the page and it says something else."
   *
   * The citation is kept here too. The user read the corrected value off that
   * same page, so the page is still where the evidence is; what changes is that
   * the value is now a person's reading rather than a model's.
   */
  function handleCorrectReview(item: ReviewItem, raw: string) {
    const text = raw.trim();
    if (!text) {
      setStatus(`Enter a value for ${item.label.toLowerCase()}, or confirm what was read.`);
      return;
    }

    // Numeric fields must stay numeric or the export schema rejects the record
    // at the boundary, which would surface as an unrelated-looking failure.
    const numeric = item.field === "pinCount" || /Mm$/.test(item.field);
    let value: unknown = text;
    if (numeric) {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setStatus(`${item.label} must be a positive number.`);
        return;
      }
      value = item.field === "pinCount" ? Math.round(parsed) : parsed;
    }

    setPart((record) => withField(record, item.field, { value, confidence: 1, method: "user" }));
    settle(item.field);
    setStatus(`Set ${item.label.toLowerCase()} to ${text}.`);
  }

  async function handleSupplyNeed(need: RequiredInput, raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_LEAD_SPAN_MM) {
      setStatus(`Enter a ${need.label.toLowerCase()} in ${need.unit}, greater than 0.`);
      return;
    }

    if (need.scope === "install") {
      setInstallLeadSpan(value);
      try {
        window.localStorage.setItem(INSTALL_LEAD_SPAN_KEY, String(value));
      } catch {
        // Remembering is a convenience; failing to remember must not block the export.
      }
    }

    setPendingNeeds([]);
    setNeedValue("");
    await handleExport(value);
  }

  const jsonPreview = JSON.stringify(part, null, 2);

  // Upload is the enterprise/air-gapped path and is available in every mode, so it is shared
  // between the commercial layout (as the fallback) and the air-gapped layout (as the only path).
  const uploadCard = (
    <label className="upload-card" htmlFor="datasheet-upload">
      <div className="upload-title">{config?.lookupEnabled ? "Fallback: upload a PDF" : "Upload a datasheet PDF"}</div>
      <div className="upload-body">
        {config?.lookupEnabled
          ? "Drop a local datasheet here if you already have the file."
          : "Datasheets are read locally and never leave your network."}
      </div>
      <input
        id="datasheet-upload"
        type="file"
        accept="application/pdf"
        onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
      />
      <div className="file-name">{selectedFile ? selectedFile.name : "No file selected"}</div>
    </label>
  );

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Forge</div>
          <h1>Vertical datasheet AI for CAD teams</h1>
          <p className="hero-copy">
            {config === null
              ? "Forge turns rad-hard datasheets into download-ready CAD bundles."
              : config.lookupEnabled
                ? "Give Forge a part number. It resolves the datasheet, parses the PDF, and generates a download-ready CAD bundle."
                : "Upload a rad-hard datasheet PDF. Forge parses it locally and generates a download-ready CAD bundle, with no data leaving your network."}
          </p>
        </div>
        <div className="status-box">{status}</div>
      </header>

      <section className="tool-row">
        {config === null ? (
          <div className="panel config-loading" aria-busy="true">
            Loading workspace...
          </div>
        ) : config.lookupEnabled ? (
          <>
            <article className="prompt-card panel">
              <div className="card-kicker">AI intake</div>
              <h2>What part are you working on?</h2>
              <p>Enter a manufacturer part number. Forge resolves the datasheet, ingests it, and prefills the normalized part record.</p>

              <form className="chat-shell" onSubmit={handlePromptSubmit}>
                <div className="chat-thread">
                  <div className="chat-bubble assistant">
                    Start with a part number. You can add a manufacturer hint if the name is ambiguous.
                  </div>
                </div>

                <div className="chat-input-row">
                  <label>
                    <span>Part number</span>
                    <input value={partPrompt} onChange={(event) => setPartPrompt(event.target.value)} placeholder="Type a part number" />
                  </label>
                  <label>
                    <span>Manufacturer hint</span>
                    <input value={manufacturerHint} onChange={(event) => setManufacturerHint(event.target.value)} placeholder="Optional" />
                  </label>
                  <button className="primary-button" type="submit" disabled={busy}>
                    Find datasheet & parse
                  </button>
                </div>
              </form>

              <div className="prompt-footnote">Resolves through the component API first. PDF upload remains the fallback.</div>

              {sourceUrl ? (
                <div className="source-banner">
                  <span>Source</span>
                  <a href={sourceUrl.href} target="_blank" rel="noreferrer">
                    {sourceUrl.href}
                  </a>
                </div>
              ) : null}
            </article>

            {uploadCard}
          </>
        ) : (
          <>
            <article className="prompt-card panel airgap-notice">
              <div className="card-kicker">Air-gapped mode</div>
              <h2>Part-number lookup is disabled</h2>
              <p>
                This deployment runs with zero network egress, so Forge never reaches an external
                component API. Upload the datasheet PDF directly and it is processed entirely on
                your own infrastructure.
              </p>
            </article>

            {uploadCard}
          </>
        )}
      </section>

      {review.length > 0 && (
        <section className="tool-row">
          <article className="panel review-panel">
            <div className="card-kicker">Needs a look</div>
            <h2 className="review-heading">
              {review.filter((item) => item.blocking).length > 0
                ? `${review.filter((item) => item.blocking).length} value${
                    review.filter((item) => item.blocking).length === 1 ? "" : "s"
                  } must be checked before export`
                : `${review.length} value${review.length === 1 ? "" : "s"} worth a second look`}
            </h2>
            <p className="review-intro">
              Forge read these but could not verify them against the datasheet text. Open one to see
              the page it came from, then confirm it or type what the page actually says.
            </p>

            {review.map((item) => {
              const open = openReview === item.field;
              // Bound once so the JSX below narrows it; `item.alternative` inside
              // a callback does not.
              const alternative = item.alternative;
              const image = reviewPageImages.find((page) => page.page === item.page);
              // A pin table is a list, not a value anyone should retype into a
              // text box. It is confirmed or it is re-read by naming the package.
              const editable = item.field !== "pins";

              return (
                <div
                  key={item.field}
                  className={`review-item${item.blocking ? " review-blocking" : ""}${
                    item.reason === "disagreement" ? " review-conflict" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="review-summary"
                    onClick={() => {
                      setOpenReview(open ? null : item.field);
                      setCorrection("");
                    }}
                    aria-expanded={open}
                  >
                    <span className="review-label">{item.label}</span>
                    <span className="review-value">
                      {item.display}
                      {/* Both readings on the summary line. A conflict the user has
                          to expand to see is a conflict most users never see. */}
                      {item.alternative && (
                        <>
                          {" vs "}
                          <span className="review-alt">{item.alternative.display}</span>
                        </>
                      )}
                    </span>
                    <span className="review-where">
                      {item.alternative
                        ? `two readings disagree${
                            item.page !== null && item.alternative.page !== null
                              ? ` · pages ${item.page} and ${item.alternative.page}`
                              : ""
                          }`
                        : item.blocking
                          ? "blocks export"
                          : item.page !== null
                            ? `page ${item.page}`
                            : "no page cited"}
                    </span>
                  </button>

                  {open && (
                    <div className="review-body">
                      <p className="review-consequence">{item.consequence}</p>
                      {item.snippet && <p className="review-snippet">Cited as: {item.snippet}</p>}

                      {/* Both pages, side by side. Settling a disagreement means
                          looking at the two places the two readers looked, and
                          showing one of them decides the question by omission. */}
                      {item.alternative ? (
                        <div className="review-compare">
                          {[
                            { which: "Forge read", value: item.display, page: item.page },
                            { which: "The model read", value: item.alternative.display, page: item.alternative.page }
                          ].map((side) => {
                            const sideImage = reviewPageImages.find((page) => page.page === side.page);
                            return (
                              <figure key={side.which} className="review-side">
                                <figcaption>
                                  <strong>{side.which}</strong> {side.value}
                                  {side.page !== null && <span className="review-where"> · page {side.page}</span>}
                                </figcaption>
                                {sideImage ? (
                                  <img
                                    className="review-page"
                                    src={`data:${sideImage.mimeType};base64,${sideImage.base64}`}
                                    alt={`Page ${sideImage.page} of the datasheet`}
                                  />
                                ) : (
                                  <p className="review-snippet">
                                    {side.page !== null
                                      ? `Open page ${side.page} to check this.`
                                      : "No page cited."}
                                  </p>
                                )}
                              </figure>
                            );
                          })}
                        </div>
                      ) : image ? (
                        <img
                          className="review-page"
                          src={`data:${image.mimeType};base64,${image.base64}`}
                          alt={`Page ${image.page} of the datasheet`}
                        />
                      ) : (
                        <p className="review-snippet">
                          {item.page !== null
                            ? `Open page ${item.page} of the datasheet to check this.`
                            : "Forge could not say which page this came from, which is itself a reason to distrust it."}
                        </p>
                      )}

                      <div className="review-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => handleConfirmReview(item)}
                        >
                          {item.alternative ? "Keep this one" : "Correct as read"}
                        </button>
                        {/* One click to take the other reading. Making the user
                            retype a value that is already on screen is how a
                            correct answer gets mistyped. */}
                        {alternative && editable && (
                          <button
                            type="button"
                            className="need-submit"
                            onClick={() => handleCorrectReview(item, alternative.display)}
                          >
                            Use {alternative.display}
                          </button>
                        )}
                        {editable && (
                          <>
                            <input
                              className="review-input"
                              value={correction}
                              placeholder="or type the right value"
                              onChange={(event) => setCorrection(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") handleCorrectReview(item, correction);
                              }}
                            />
                            <button
                              type="button"
                              className="need-submit"
                              onClick={() => handleCorrectReview(item, correction)}
                            >
                              Use this
                            </button>
                          </>
                        )}
                      </div>
                      {!editable && (
                        <p className="review-snippet">
                          To change a pinout, name the package instead of editing pins one by one.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </article>
        </section>
      )}

      <section className="tool-row export-row">
        <div className="format-card panel">
          <div className="card-title">Export destination</div>
          <div className="format-grid">
            {formatOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === selectedFormat ? "format-button active" : "format-button"}
                onClick={() => setSelectedFormat(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.note}</small>
              </button>
            ))}
          </div>
          {/*
            A remembered install-scoped answer is sent WITHOUT being asked for.
            That is what makes it a one-time cost: the first ceramic flat pack
            prompts, and every one after it exports straight through.
          */}
          <button
            className="export-button"
            type="button"
            onClick={() => handleExport(installLeadSpan ?? undefined)}
            disabled={busy || !part.partNumber.value}
          >
            Download ZIP
          </button>

          {/*
            The export asked for a value no datasheet carries. Shown here rather
            than as an error string, because it is answerable: three parts in the
            bench corpus are exactly this one number away from a bundle, and the
            route has been able to accept it all along.
          */}
          {pendingNeeds.map((need) => (
            <div key={need.field} className="need-prompt">
              <label className="need-label" htmlFor={`need-${need.field}`}>
                {need.label} ({need.unit})
              </label>
              <p className="need-why">{need.why}</p>
              <div className="need-row">
                <input
                  id={`need-${need.field}`}
                  type="number"
                  min="0"
                  step="0.01"
                  max={MAX_LEAD_SPAN_MM}
                  value={needValue}
                  placeholder={`e.g. 10.16`}
                  onChange={(event) => setNeedValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSupplyNeed(need, needValue);
                    }
                  }}
                />
                <button
                  type="button"
                  className="need-submit"
                  disabled={busy}
                  onClick={() => handleSupplyNeed(need, needValue)}
                >
                  Build with this
                </button>
              </div>
              {need.scope === "install" && (
                <p className="need-scope">
                  Asked once. This is a property of your assembly line, not of this part, so Forge
                  remembers it for every part after this one.
                </p>
              )}
            </div>
          ))}

          {installLeadSpan !== null && pendingNeeds.length === 0 && (
            <p className="need-scope">
              Formed lead span: {installLeadSpan} mm (remembered).{" "}
              <button
                type="button"
                className="need-clear"
                onClick={() => {
                  setInstallLeadSpan(null);
                  try {
                    window.localStorage.removeItem(INSTALL_LEAD_SPAN_KEY);
                  } catch {
                    // Clearing is best-effort; the in-memory value is already gone.
                  }
                }}
              >
                Change
              </button>
            </p>
          )}
        </div>

        <div className="mini-panel panel">
          <div className="card-title">What Forge outputs</div>
          <ul className="capability-list">
            <li>Normalized part record with provenance.</li>
            <li>Symbol, footprint, and STEP source files.</li>
            <li>Vendor-neutral bundle for Altium and Cadence until native emitters land.</li>
          </ul>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel">
          <div className="panel-title">Parsed part record</div>
          <div className="field-grid">
            <label>
              <span>
                Part number <Provenance field={part.partNumber} />
              </span>
              <input
                value={part.partNumber.value ?? ""}
                onChange={(event) => setPart({ ...part, partNumber: userEdited(event.target.value || null) })}
              />
            </label>
            <label>
              <span>
                Manufacturer <Provenance field={part.manufacturer} />
              </span>
              <input
                value={part.manufacturer.value ?? ""}
                onChange={(event) => setPart({ ...part, manufacturer: userEdited(event.target.value || null) })}
              />
            </label>
            <label>
              <span>
                Package type <Provenance field={part.packageType} />
              </span>
              <input
                value={part.packageType.value ?? ""}
                placeholder="e.g. SOIC-8"
                onChange={(event) => setPart({ ...part, packageType: userEdited(event.target.value || null) })}
              />
              {/*
                The packages THIS datasheet names, which is a different question
                from which ones Forge can build. Multi-package ambiguity blocks
                more parts than any parsing defect, and in every case the document
                does say what the packages are and does not say which one the user
                is holding. So it is asked, once, with the answers pre-filled.
              */}
              {packageChoices.length > 1 && (
                <span className="package-picker">
                  <span className="package-picker-label">
                    This datasheet describes {packageChoices.length} packages. Which one are you
                    building?
                    {origin !== null && " Picking one re-reads the datasheet for that package."}
                  </span>
                  {packageChoices.map((variant) => {
                    // What this chip will do, from the server, which found out by
                    // running the real footprint generator. Absent means the
                    // record could not resolve at all, and the panel below says
                    // so once rather than marking every chip dead in turn.
                    const outcome = packageOutcomes.get(variant.designator);
                    const suffix =
                      outcome?.status === "needs-input"
                        ? " (needs one number)"
                        : outcome?.status === "unsupported"
                          ? " (not buildable yet)"
                          : "";
                    return (
                      <button
                        key={variant.designator}
                        type="button"
                        disabled={busy}
                        className={[
                          "package-chip",
                          part.packageType.value === variant.designator ? "active" : "",
                          outcome ? `outcome-${outcome.status}` : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        // Never disabled on an unsupported outcome. The pinout is
                        // still worth having, the refusal is ours rather than the
                        // datasheet's, and a chip that cannot be pressed cannot
                        // explain itself.
                        title={outcome?.reason ?? outcome?.needs[0]?.why ?? undefined}
                        onClick={() => handlePackageChoice(variant.designator)}
                      >
                        {variant.designator}
                        {suffix}
                      </button>
                    );
                  })}
                  {/*
                    Said once, under the row, rather than per chip. The record
                    blocks every package equally, so marking each one would
                    present one problem as several and imply another choice might
                    avoid it.
                  */}
                  {packageChoice && !packageChoice.ok && (
                    <span className="package-picker-note">
                      No package here can be built yet: the datasheet reading is missing{" "}
                      {packageChoice.blockedBy.join(" and ")}. Picking one still re-reads the
                      datasheet for that package, which is often what fills it in.
                    </span>
                  )}
                </span>
              )}
              {supportedPackages.length > 0 && (
                <span className="package-picker">
                  <span className="package-picker-label">
                    Characterised footprints (anything else is refused):
                  </span>
                  {supportedPackages.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      disabled={busy}
                      className={
                        part.packageType.value === suggestion
                          ? "package-chip active"
                          : "package-chip"
                      }
                      onClick={() => handlePackageChoice(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <label>
              <span>
                Pin count <Provenance field={part.pinCount} />
              </span>
              <input
                type="number"
                value={part.pinCount.value ?? ""}
                placeholder="not found"
                onChange={(event) =>
                  setPart({ ...part, pinCount: userEdited(Number(event.target.value) || null) })
                }
              />
            </label>
          </div>

          <div className="subpanel-title">Package dimensions</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value (mm)</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {dimensionsRows.map(([label, field]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <Cell field={field} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="subpanel-title">Radiation data</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>TID</td>
                  <Cell field={part.radiation.tid} />
                </tr>
                <tr>
                  <td>SEE</td>
                  <Cell field={part.radiation.see} />
                </tr>
                <tr>
                  <td>SEL</td>
                  <Cell field={part.radiation.sel} />
                </tr>
                <tr>
                  <td>QML/QPL</td>
                  <Cell field={part.radiation.qmlClass} />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="subpanel-title">
            Pin table <Provenance field={part.pins} />
          </div>
          {part.pins.value === null && (
            <div className="empty-state">
              No pin table was detected in this datasheet. Pins are left unknown rather than
              estimated, and export is blocked until they are filled in.
            </div>
          )}
          <div className="table-wrap pin-table">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {(part.pins.value ?? []).map((pin, index) => (
                  <tr key={`${pin.number}-${index}`}>
                    <td>
                      <input value={pin.number} onChange={(event) => setPart(updatePin(part, index, "number", event.target.value))} />
                    </td>
                    <td>
                      <input value={pin.name} onChange={(event) => setPart(updatePin(part, index, "name", event.target.value))} />
                    </td>
                    <td>
                      <select
                        value={pin.electricalType}
                        onChange={(event) => setPart(updatePin(part, index, "electricalType", event.target.value))}
                      >
                        <option value="unspecified">unspecified</option>
                        <option value="power">power</option>
                        <option value="input">input</option>
                        <option value="output">output</option>
                        <option value="bidirectional">bidirectional</option>
                        <option value="passive">passive</option>
                        <option value="nc">nc</option>
                        <option value="open_collector">open_collector</option>
                        <option value="open_emitter">open_emitter</option>
                      </select>
                    </td>
                    <td>{pin.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="panel json-panel">
          <div className="panel-title">Normalized JSON</div>
          <textarea readOnly value={jsonPreview} />
          <div className="note-list">
            {part.notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}