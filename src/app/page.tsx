"use client";

import { useEffect, useMemo, useState } from "react";
import { isUntraceable } from "../lib/provenance";
import type { Extracted, ExportFormat, LeadWidth, PartRecord, PinRecord } from "../lib/types";
// Runtime import, and safe in the browser bundle: `packagevariants.ts` imports
// nothing at all and is pure string work over designators.
import { declaredLeadCount, pinTableFor } from "../lib/packagevariants";
// Type-only import: erased at compile time, so no retrieval-layer runtime code
// (node:crypto, the resolvers) is pulled into the client bundle.
import type { DeploymentMode } from "../lib/retrieval";
// Type-only for the same reason: `exporters.ts` reaches the CAD generators.
import type { PackageChoice, PackageOption, RequiredInput } from "../lib/exporters";
import type { ReviewItem } from "../lib/review";
import type { ConfidenceCheck } from "../lib/confidence";
// Type-only: `pagerender.ts` dynamically imports mupdf, which must not follow
// the review panel into the browser bundle.
import type { RenderedPage } from "../lib/pagerender";

/**
 * The workspace.
 *
 * ## What this screen is for
 *
 * One job: turn a datasheet into a symbol, a footprint and a 3D body an engineer
 * can drop into a library without checking every number by hand. Everything on
 * screen either moves that along or says why it cannot.
 *
 * ## The rule the layout follows
 *
 * The page IS the workflow, top to bottom, and nothing appears before it is
 * relevant. Source, then what was read, then whatever blocks an export, then the
 * export, then the full record for anyone who wants to read it.
 *
 * A panel with nothing to say is not rendered at all. An empty "0 issues" card
 * costs the same glance as a real one and teaches the reader that panels are
 * usually noise.
 *
 * ## Questions carry their evidence
 *
 * Where the export needs a number, the page of the datasheet that number is
 * printed on is rendered NEXT TO the input. The route already located those
 * pages and shipped them; until 2026-08-14 nothing rendered them, so a user was
 * sent to "the vendor's application note" for a value printed on a page we had
 * already found. Answering should take seconds and involve no hunting.
 */

interface AppConfig {
  mode: DeploymentMode;
  lookupEnabled: boolean;
}

const formatOptions: Array<{ value: ExportFormat; label: string; note: string; ready: boolean }> = [
  { value: "kicad", label: "KiCad", note: ".kicad_sym · .kicad_mod · .step", ready: true },
  // Each format has its own generator reading the same geometry. Cadence says
  // "not built" rather than offering a renamed KiCad file, which is what the
  // whole bundle used to do.
  { value: "altium", label: "Altium", note: ".SchLib · .PcbLib", ready: true },
  { value: "cadence", label: "Cadence / OrCAD", note: "generator not built yet", ready: false }
];

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
    leadSpanMm: nothing<LeadWidth>(),
    leadContactMm: nothing<LeadWidth>(),
    thermalPadLengthMm: nothing<number>(),
    thermalPadWidthMm: nothing<number>(),
    landPadLengthMm: nothing<number>(),
    landPadWidthMm: nothing<number>(),
    landSpanMm: nothing<number>(),
    leadSides: nothing<2 | 4>(),
    leadForm: nothing<"gullwing" | "nolead" | "straight">(),
    mounting: nothing<"smd" | "through-hole">(),
    leadDiameterMm: nothing<number>(),
    vacantLeadSlot: nothing<number>(),
    leadsPerSide: nothing<string>(),
    solderMaskExpansionMm: nothing<number>(),
    solderMaskDefined: nothing<"solder-mask-defined" | "non-solder-mask-defined">(),
    thermalViaDiameterMm: nothing<number>(),
    thermalViaPitchMm: nothing<number>()
  },
  radiation: { tid: nothing<string>(), see: nothing<string>(), sel: nothing<string>(), qmlClass: nothing<string>() },
  sourceFileName: "",
  notes: []
};

/**
 * A hand-entered value is fully trusted but has no citation, and must never keep
 * the reader's provenance. Editing a field is a change of method.
 */
function userEdited<T>(value: T | null): Extracted<T> {
  return { value, confidence: value === null ? null : 1, method: value === null ? null : "user", citation: null };
}

/**
 * Where an `install`-scoped answer is remembered. Survives the session deliberately.
 *
 * A PREFIX rather than one key per field. There are two of these now, the formed
 * lead span and the formed foot, both made by the same forming die, and the
 * single-key version silently overwrote one with the other. Keying by field name
 * also means a third install-scoped question needs no change here, which is the
 * "fixed in one place, not the other" trap this codebase has hit repeatedly.
 */
const INSTALL_KEY_PREFIX = "forge.install.";

/** Field names whose answers belong to the assembly line rather than the part. */
const INSTALL_FIELDS = ["formedLeadSpanMm", "formedLeadContactMm"] as const;

/** Human labels for the remembered-value notice. */
const INSTALL_LABELS: Record<string, string> = {
  formedLeadSpanMm: "Formed lead span",
  formedLeadContactMm: "Formed foot length"
};

/** Largest span the export route accepts, mirrored so the UI refuses it first. */
const MAX_LEAD_SPAN_MM = 200;

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

/**
 * Where a value came from, in as few characters as carry the meaning.
 *
 * Always present, never loud. Someone signing off a part has to tell a value the
 * document stated from one a model inferred from one they typed, and has to do
 * it by scanning rather than by clicking.
 */
function Provenance({ field }: { field: Extracted<unknown> }) {
  if (field.value === null) return <span className="prov prov-none">not read</span>;
  if (isUntraceable(field)) {
    return (
      <span
        className="prov prov-warn"
        title="A model produced this and it could not be located in the datasheet. Check it against the source, then confirm."
      >
        unverified
      </span>
    );
  }
  const parts: string[] = [];
  if (field.citation) parts.push(`p${field.citation.page}`);
  if (field.method === "user") parts.push("you");
  else if (field.method === "user-confirmed") parts.push("checked");
  else if (field.method === "vlm-drawing") parts.push("drawing");
  else if (field.method === "vlm") parts.push("read");
  else if (field.method) parts.push(field.method);
  return (
    <span className="prov" title={field.citation?.snippet ?? undefined}>
      {parts.join(" · ")}
    </span>
  );
}

/** A value, or a min/max pair the way a drawing prints it. */
function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const range = value as { minMm?: number; maxMm?: number };
    if (typeof range.minMm === "number" && typeof range.maxMm === "number") {
      return range.minMm === range.maxMm ? `${range.minMm}` : `${range.minMm}–${range.maxMm}`;
    }
  }
  return String(value);
}

/** One row of the record: label, value, provenance. The unit lives in the label. */
function Row({ label, unit, field }: { label: string; unit?: string; field: Extracted<unknown> }) {
  return (
    <tr className={field.value === null ? "row-empty" : undefined}>
      <th scope="row">
        {label}
        {unit && <span className="unit"> {unit}</span>}
      </th>
      <td className="num">{showValue(field.value)}</td>
      <td className="meta">
        <Provenance field={field} />
      </td>
    </tr>
  );
}

/** A rendered datasheet page, captioned with what it is. */
function PageImage({
  image,
  caption,
  page
}: {
  image: RenderedPage | undefined;
  caption: string;
  page: number | null | undefined;
}) {
  if (!image) {
    return (
      <div className="page-missing">
        {page
          ? `${caption}, page ${page}. Could not be rendered.`
          : "No page of this datasheet answers this, so there is nothing to show."}
      </div>
    );
  }
  return (
    <figure className="page">
      <img src={`data:${image.mimeType};base64,${image.base64}`} alt={`${caption}, page ${image.page}`} />
      <figcaption>
        {caption} <span className="page-n">page {image.page}</span>
      </figcaption>
    </figure>
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
  if (field === "electricalType") pin.electricalType = value as PinRecord["electricalType"];
  else if (field === "number" || field === "name") pin[field] = value;
  // The table was edited by hand, so the array's provenance changes with it.
  next.pins = { value: pins, confidence: 1, method: "user", citation: next.pins.citation };
  return next;
}

function formatSourceUrl(sourceUrl?: string) {
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    // `new URL` happily parses `javascript:` and `data:`, and this value becomes
    // an anchor href. Our URLs come from the SSRF-guarded fetch path so they are
    // already http(s); this is the last hop before the DOM and the check is one
    // line, so it is enforced here rather than relying on an invariant held three
    // layers away.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * What a package choice actually produced, said plainly.
 *
 * A choice that resolves a pinout and one that changes nothing look identical in
 * the record unless the difference is stated, and the second is a real outcome:
 * the document may simply not draw a pinout for that package.
 */
function describeChoice(record: PartRecord, designator: string): string {
  const pins = record.pins.value?.length ?? 0;
  if (pins > 0 && record.pinCount.value !== null) return `Read ${pins} pins for ${designator}.`;
  if (pins > 0) return `Found ${pins} pins for ${designator}, but nothing confirms the count.`;
  return `This datasheet draws no pinout for ${designator}.`;
}

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [partPrompt, setPartPrompt] = useState("");
  const [manufacturerHint, setManufacturerHint] = useState("");
  const [part, setPart] = useState<PartRecord>(defaultPart);

  // How the record was produced, so a package choice can be answered by READING
  // AGAIN with that package rather than by writing it into the record. Every pin
  // reader takes the package as an argument and uses it to choose among a
  // document's per-package pinouts, so a package that arrives after the read
  // arrives too late to be used.
  const [origin, setOrigin] = useState<
    { kind: "upload"; file: File } | { kind: "lookup"; partNumber: string; manufacturer: string } | null
  >(null);

  // The packages the document offered, held separately from the record because
  // the record's own list is filtered against the pin count it settled on. Once a
  // choice resolves that count the alternatives would vanish and the user could
  // not change their mind.
  const [offeredVariants, setOfferedVariants] = useState<PartRecord["packageVariants"]>([]);
  const [packageChoice, setPackageChoice] = useState<PackageChoice | null>(null);

  // Values the export asked for. Empty unless the last attempt came back 422.
  const [pendingNeeds, setPendingNeeds] = useState<RequiredInput[]>([]);
  // One box per question. Sharing one made a part needing three numbers
  // unanswerable in principle.
  const [needValues, setNeedValues] = useState<Record<string, string>>({});
  // Answers already given, carried across retries: the export asks for whatever
  // is still missing, so without this the first answer is lost every time.
  const [supplied, setSupplied] = useState<Record<string, number | string>>({});

  const [review, setReview] = useState<ReviewItem[]>([]);
  const [pageImages, setPageImages] = useState<RenderedPage[]>([]);
  const [checks, setChecks] = useState<ConfidenceCheck[]>([]);
  const [drawingPage, setDrawingPage] = useState<number | null>(null);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");

  // An `install`-scoped answer belongs to the assembly line rather than the part,
  // so it is asked once and remembered. A `part`-scoped answer is never stored,
  // because reusing one across parts would be a guess.
  const [installAnswers, setInstallAnswers] = useState<Record<string, number>>({});

  useEffect(() => {
    try {
      const restored: Record<string, number> = {};
      for (const field of INSTALL_FIELDS) {
        const saved = window.localStorage.getItem(`${INSTALL_KEY_PREFIX}${field}`);
        const parsed = saved === null ? NaN : Number(saved);
        if (Number.isFinite(parsed) && parsed > 0) restored[field] = parsed;
      }
      if (Object.keys(restored).length > 0) setInstallAnswers(restored);
    } catch {
      // A blocked localStorage costs one re-entry, not the export.
    }
  }, []);

  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("kicad");
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: AppConfig) => {
        if (cancelled) return;
        setConfig(data);
        setStatus(data.lookupEnabled ? "Ready." : "Air-gapped. Upload a datasheet to begin.");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("Could not reach the server.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loaded = Boolean(part.id);
  const imageFor = (page: number | null | undefined) =>
    page ? pageImages.find((image) => image.page === page) : undefined;

  const packageOutcomes = useMemo(
    () => new Map(packageChoice?.ok ? packageChoice.options.map((option) => [option.designator, option]) : []),
    [packageChoice]
  );

  /**
   * The questions we ALREADY know the answer to, before anything is pressed.
   *
   * `packageOptions` runs the real footprint generator once per package when the
   * datasheet is read, so the server knows which numbers are missing the moment
   * it answers. This used to be thrown away: the user pressed "Build library",
   * got refused, and only then saw the question. Same work, one dead end.
   *
   * `pendingNeeds` still wins when it is populated, because that is the answer
   * from an actual attempt with the values already supplied, and it shrinks as
   * they are answered.
   */
  const knownNeeds = useMemo(() => {
    if (!packageChoice?.ok) return [];
    const chosen = packageChoice.options.find((option) => option.designator === part.packageType.value);
    // The resolved package where there is one, otherwise the only offer. With
    // several unresolved packages the questions differ per package, and showing
    // one package's questions as if they were the part's would be a guess.
    const option = chosen ?? (packageChoice.options.length === 1 ? packageChoice.options[0] : undefined);
    return option?.status === "needs-input" ? option.needs : [];
  }, [packageChoice, part.packageType.value]);

  const shownNeeds = pendingNeeds.length > 0 ? pendingNeeds : knownNeeds;

  const failedChecks = checks.filter((check) => check.state === "fail");
  const openChecks = checks.filter((check) => check.state !== "pass");
  const blockingReview = review.filter((item) => item.blocking);
  const sourceUrl = formatSourceUrl(part.sourceUrl);
  const pins = part.pins.value ?? [];
  const exportStep = offeredVariants.length > 1 ? 5 : 4;

  // ---------------------------------------------------------------------------
  // Handlers. Behaviour is carried over unchanged; only the presentation around
  // them was rebuilt.
  // ---------------------------------------------------------------------------

  function absorb(payload: Record<string, unknown>, record: PartRecord, keepChoice: boolean) {
    setPart(record);
    setReview((payload.review as ReviewItem[]) ?? []);
    setPageImages((payload.reviewPages as RenderedPage[]) ?? []);
    setChecks((payload.checks as ConfidenceCheck[]) ?? []);
    setDrawingPage((payload.packageDrawing as { page?: number } | null)?.page ?? null);
    setOpenReview(null);
    setPendingNeeds([]);
    setSupplied({});
    // A re-read keeps the packages the first read offered; see `offeredVariants`.
    if (!keepChoice) {
      setOfferedVariants(record.packageVariants);
      setPackageChoice((payload.packageChoice as PackageChoice) ?? null);
    }
  }

  async function handleLookup(options?: { partNumber?: string; manufacturer?: string; packageType?: string }) {
    const trimmedPart = (options?.partNumber ?? partPrompt).trim();
    if (!trimmedPart) {
      setStatus("Enter a part number first.");
      return;
    }
    const trimmedManufacturer = (options?.manufacturer ?? manufacturerHint).trim();

    setBusy(true);
    setStatus(options?.packageType ? `Re-reading ${trimmedPart} as ${options.packageType}…` : `Finding ${trimmedPart}…`);

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Optional fields are OMITTED when blank rather than sent empty: the
        // schema requires a non-empty string when the key is present, so an empty
        // manufacturer failed the whole request as "part number is required".
        body: JSON.stringify({
          partNumber: trimmedPart,
          ...(trimmedManufacturer ? { manufacturer: trimmedManufacturer } : {}),
          ...(options?.packageType ? { packageType: options.packageType } : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not find that datasheet.");

      const record = payload.part as PartRecord;
      absorb(payload, record, Boolean(options?.packageType));
      setSelectedFile(null);
      setOrigin({ kind: "lookup", partNumber: trimmedPart, manufacturer: trimmedManufacturer });
      setStatus(options?.packageType ? describeChoice(record, options.packageType) : `Read ${trimmedPart}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Lookup failed.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File | null, packageType?: string) {
    setSelectedFile(file);
    if (!file) return;

    setBusy(true);
    setStatus(packageType ? `Re-reading ${file.name} as ${packageType}…` : `Reading ${file.name}…`);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (packageType) formData.append("packageType", packageType);

      const response = await fetch("/api/parse", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read that datasheet.");

      const record = payload.part as PartRecord;
      absorb(payload, record, Boolean(packageType));
      setOrigin({ kind: "upload", file });
      setStatus(packageType ? describeChoice(record, packageType) : `Read ${record.partNumber.value ?? file.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Parse failed.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Answers a package choice, re-reading the datasheet only when it has to.
   *
   * ## Keeping the pinout was wrong on exactly the documents this button is for
   *
   * This used to relabel the record and keep the pins whenever the record was
   * complete, on the reasoning that a re-read can only take a working pinout
   * away. That holds for a document with one pinout. This button only appears
   * when the document describes SEVERAL, and their pinouts differ: an ADS1256 is
   * an SSOP-20 or an SSOP-28, an LT1013 an 8, 14 or 16 lead part. Relabelling a
   * twenty-pin reading as an SSOP-28 produced a record claiming twenty pins in a
   * twenty-eight pin package, and the status line said the pinout had been kept
   * as though that were a courtesy. The lead count was on screen beside the
   * button the whole time.
   *
   * So there are three cases, and only the middle one is new:
   *
   *   1. the document gave THIS package its own pin table -> take it, no re-read
   *   2. the pins we hold contradict the package's own lead count -> re-read
   *   3. nothing contradicts -> relabel, as before
   */
  async function handlePackageChoice(designator: string) {
    const held = part.pins.value ?? [];
    const complete = held.length > 0 && part.pinCount.value !== null;

    const table = pinTableFor(part.pinTablesByPackage, designator);
    if (table) {
      setPart({
        ...part,
        packageType: userEdited(designator),
        pins: userEdited(table.pins),
        pinCount: userEdited(table.pins.length)
      });
      setStatus(`Package set to ${designator}, with the ${table.pins.length}-pin table this datasheet prints for it.`);
      return;
    }

    const declared = declaredLeadCount(designator);
    const contradicts = complete && declared !== null && declared !== part.pinCount.value;

    if (complete && !contradicts) {
      setPart({ ...part, packageType: userEdited(designator) });
      setStatus(`Package set to ${designator}. The pinout was already read, so it was kept.`);
      return;
    }
    if (origin?.kind === "upload") return handleFile(origin.file, designator);
    if (origin?.kind === "lookup") {
      return handleLookup({
        partNumber: origin.partNumber,
        manufacturer: origin.manufacturer,
        packageType: designator
      });
    }
    setPart({ ...part, packageType: userEdited(designator) });
  }

  /**
   * Builds the bundle, sending every answer already given.
   *
   * `answers` is passed explicitly rather than read from state for the same
   * reason `formedLeadSpan` is: a React state update is not visible to the
   * handler that queued it, and the whole point is to answer and retry at once.
   */
  async function handleExport(
    install: Record<string, number> = installAnswers,
    answers: Record<string, number | string> = supplied
  ) {
    setBusy(true);
    setStatus(`Building ${selectedFormat.toUpperCase()}…`);

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          part,
          format: selectedFormat,
          // Every answered question, under the field name the refusal used.
          ...answers,
          // Install-scoped answers last, so a remembered value is sent even on
          // an export the user started without answering anything this time.
          ...install
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        // A refusal the user can ANSWER is a different thing from one they
        // cannot. `needs` populated means the footprint is a few values away.
        if (payload?.code === "INPUT_REQUIRED" && Array.isArray(payload.needs) && payload.needs.length > 0) {
          setPendingNeeds(payload.needs as RequiredInput[]);
          setStatus(
            payload.needs.length === 1
              ? "One value is needed to build the footprint."
              : `${payload.needs.length} values are needed to build the footprint.`
          );
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

      const note = decodeURIComponent(response.headers.get("X-Forge-Export-Note") || "");
      setStatus(note || "Downloaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  /** Writes one field back by its dotted path, touching nothing else. */
  function withField(record: PartRecord, path: string, patch: Partial<Extracted<unknown>>): PartRecord {
    if (!path.includes(".")) {
      const current = (record as unknown as Record<string, Extracted<unknown>>)[path];
      return { ...record, [path]: { ...current, ...patch } } as PartRecord;
    }
    const [group, key] = path.split(".");
    const bag = (record as unknown as Record<string, Record<string, Extracted<unknown>>>)[group];
    return { ...record, [group]: { ...bag, [key]: { ...bag[key], ...patch } } } as PartRecord;
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
   * Recorded as `user-confirmed` rather than `user`, and the citation is KEPT: a
   * model read it AND a person checked it against the page it claims, which is a
   * stronger record than either alone. It is also what unblocks an export, since
   * an uncited model value cannot pass the export gate and a confirmed one can.
   */
  function handleConfirmReview(item: ReviewItem) {
    setPart((record) => withField(record, item.field, { confidence: 1, method: "user-confirmed" }));
    settle(item.field);
    setStatus(`Confirmed ${item.label.toLowerCase()} against page ${item.page ?? "?"}.`);
  }

  /**
   * "I looked at the page and it says something else."
   *
   * The citation is kept here too. The corrected value was read off that same
   * page, so that is still where the evidence is; what changes is that the value
   * is now a person's reading rather than a model's.
   */
  function handleCorrectReview(item: ReviewItem, raw: string) {
    const text = raw.trim();
    if (!text) {
      setStatus(`Enter a value for ${item.label.toLowerCase()}, or confirm what was read.`);
      return;
    }
    // Numeric fields must stay numeric or the export schema rejects the record at
    // the boundary, which surfaces as an unrelated-looking failure.
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

  /** Answers one outstanding question and retries the export immediately. */
  async function handleSupplyNeed(need: RequiredInput, raw: string) {
    const text = raw.trim();
    let value: number | string;

    if (need.unit === "counts") {
      // Four whole counts from pin 1. Checked here so a typo is caught beside the
      // box rather than as a 400 from the route.
      if (!/^\d{1,3}(,\d{1,3}){3}$/.test(text)) {
        setStatus("Enter four counts separated by commas, e.g. 6,6,6,5.");
        return;
      }
      value = text;
    } else if (need.unit === "count") {
      const parsed = Number(text);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setStatus(`${need.label} must be a whole number of 1 or more.`);
        return;
      }
      value = parsed;
    } else {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_LEAD_SPAN_MM) {
        setStatus(`Enter ${need.label.toLowerCase()} in mm, greater than 0.`);
        return;
      }
      value = parsed;
    }

    // Remembered UNDER ITS OWN FIELD NAME. The single-value version stored any
    // install answer as the lead span, so answering the foot overwrote the span
    // with it and the next flat pack was built from the wrong number.
    const nextInstall =
      need.scope === "install" && typeof value === "number"
        ? { ...installAnswers, [need.field]: value }
        : installAnswers;
    if (nextInstall !== installAnswers) {
      setInstallAnswers(nextInstall);
      try {
        window.localStorage.setItem(`${INSTALL_KEY_PREFIX}${need.field}`, String(value));
      } catch {
        // Remembering is a convenience; failing to remember must not block.
      }
    }

    const answers = { ...supplied, [need.field]: value };
    setSupplied(answers);
    setNeedValues((current) => ({ ...current, [need.field]: "" }));
    // Cleared optimistically. The retry repopulates it with whatever is STILL
    // missing, so a part needing three numbers walks down to none.
    setPendingNeeds([]);
    // The freshly typed answer is passed alongside the remembered ones, because
    // a React state update is not visible to the handler that queued it.
    await handleExport(nextInstall, answers);
  }

  // ---------------------------------------------------------------------------

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-id">
          <span className="wordmark">Forge</span>
          <span className="bar-sub">datasheet to CAD library</span>
        </div>
        {config && <span className={`mode mode-${config.mode}`}>{config.lookupEnabled ? "commercial" : "air-gapped"}</span>}
      </header>

      <main className="flow">
        {/* 1. SOURCE --------------------------------------------------------- */}
        <section className="step">
          <h2 className="step-title">
            <span className="step-n">1</span> Datasheet
          </h2>

          <div className="source">
            <label className="drop" htmlFor="datasheet-upload">
              <input
                id="datasheet-upload"
                type="file"
                accept="application/pdf"
                onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
                disabled={busy}
              />
              <span className="drop-main">{selectedFile ? selectedFile.name : "Choose a PDF"}</span>
              <span className="drop-sub">
                {selectedFile
                  ? "Click to replace"
                  : config?.lookupEnabled
                    ? "or find one by part number"
                    : "The file never leaves this machine"}
              </span>
            </label>

            {config?.lookupEnabled && (
              <form
                className="lookup"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleLookup();
                }}
              >
                <div className="lookup-fields">
                  <label>
                    <span>Part number</span>
                    <input
                      value={partPrompt}
                      onChange={(event) => setPartPrompt(event.target.value)}
                      placeholder="LM358"
                    />
                  </label>
                  <label>
                    <span>
                      Manufacturer <em>optional</em>
                    </span>
                    <input
                      value={manufacturerHint}
                      onChange={(event) => setManufacturerHint(event.target.value)}
                      placeholder="Texas Instruments"
                    />
                  </label>
                </div>
                <button type="submit" className="btn" disabled={busy || !partPrompt.trim()}>
                  Find datasheet
                </button>
              </form>
            )}
          </div>
        </section>

        {loaded && (
          <>
            {/* 2. WHAT WAS READ ---------------------------------------------- */}
            <section className="step">
              <h2 className="step-title">
                <span className="step-n">2</span> What was read
              </h2>

              <div className="identity">
                <div className="identity-main">
                  <span className="ident-part">{part.partNumber.value ?? "unknown part"}</span>
                  <span className="ident-sub">
                    {[part.manufacturer.value, part.packageType.value].filter(Boolean).join(" · ") || "package not read"}
                  </span>
                </div>
                <dl className="identity-facts">
                  <div>
                    <dt>Pins</dt>
                    <dd>{part.pinCount.value ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Outline</dt>
                    <dd>{part.packageOutlineCode.value ?? part.jedecOutline.value ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Mounting</dt>
                    <dd>{part.dimensions.mounting.value ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>
                      {sourceUrl ? (
                        <a href={sourceUrl.toString()} target="_blank" rel="noreferrer noopener">
                          {sourceUrl.hostname}
                        </a>
                      ) : (
                        part.sourceFileName || "—"
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              {checks.length > 0 && (
                <div className={`checks${failedChecks.length > 0 ? " checks-bad" : ""}`}>
                  <p className="checks-head">
                    {failedChecks.length > 0
                      ? `${failedChecks.length} consistency check${failedChecks.length === 1 ? "" : "s"} failed`
                      : `All ${checks.filter((c) => c.state === "pass").length} runnable consistency checks passed`}
                  </p>
                  {openChecks.length > 0 && (
                    <ul>
                      {openChecks.map((check) => (
                        <li key={check.id} className={`check check-${check.state}`}>
                          <span className="check-label">{check.label}</span>
                          <span className="check-detail">{check.detail}</span>
                          {check.consequence && <span className="check-why">{check.consequence}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {/* 3. REVIEW ------------------------------------------------------ */}
            {review.length > 0 && (
              <section className="step">
                <h2 className="step-title">
                  <span className="step-n">3</span> Worth a look
                  {blockingReview.length > 0 && (
                    <span className="badge">{blockingReview.length} blocking export</span>
                  )}
                </h2>
                <p className="step-note">
                  Read, but not verified. Open one to see the page it came from, then confirm it or correct it.
                </p>

                <ul className="reviews">
                  {review.map((item) => {
                    const open = openReview === item.field;
                    const image = imageFor(item.page);
                    return (
                      <li key={item.field} className={`rev${item.blocking ? " rev-block" : ""}`}>
                        <button
                          type="button"
                          className="rev-head"
                          onClick={() => {
                            setOpenReview(open ? null : item.field);
                            setCorrection("");
                          }}
                          aria-expanded={open}
                        >
                          <span className="rev-caret">{open ? "▾" : "▸"}</span>
                          <span className="rev-label">{item.label}</span>
                          <span className="rev-value">{item.display}</span>
                          <span className="rev-where">{item.page ? `p${item.page}` : "no page"}</span>
                        </button>

                        {open && (
                          <div className="rev-body">
                            <div className="rev-left">
                              <p className="rev-consequence">{item.consequence}</p>
                              {item.snippet && <p className="rev-snippet">“{item.snippet}”</p>}
                              <div className="rev-actions">
                                <button type="button" className="btn btn-primary" onClick={() => handleConfirmReview(item)}>
                                  Correct as read
                                </button>
                                <div className="rev-correct">
                                  <input
                                    value={correction}
                                    placeholder="or the right value"
                                    onChange={(event) => setCorrection(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        handleCorrectReview(item, correction);
                                      }
                                    }}
                                  />
                                  <button type="button" className="btn" onClick={() => handleCorrectReview(item, correction)}>
                                    Set
                                  </button>
                                </div>
                              </div>
                            </div>
                            <div className="rev-right">
                              <PageImage image={image} caption="Cited page" page={item.page} />
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* 4. PACKAGE ----------------------------------------------------- */}
            {offeredVariants.length > 1 && (
              <section className="step">
                <h2 className="step-title">
                  <span className="step-n">4</span> Package
                </h2>
                <p className="step-note">
                  This datasheet describes {offeredVariants.length} packages, and a footprint is per package. Each one says
                  what it would actually build.
                </p>

                <ul className="packages">
                  {offeredVariants.map((variant) => {
                    const outcome: PackageOption | undefined = packageOutcomes.get(variant.designator);
                    const active = part.packageType.value === variant.designator;
                    return (
                      <li key={variant.designator}>
                        <button
                          type="button"
                          className={`pkg${active ? " pkg-active" : ""}`}
                          disabled={busy}
                          onClick={() => handlePackageChoice(variant.designator)}
                        >
                          <span className="pkg-name">{variant.designator}</span>
                          <span className="pkg-meta">
                            {variant.family}
                            {variant.leadCount ? ` · ${variant.leadCount} leads` : ""}
                          </span>
                          {outcome && (
                            <span className={`pkg-status pkg-${outcome.status}`}>
                              {outcome.status === "ships"
                                ? "builds now"
                                : outcome.status === "needs-input"
                                  ? `${outcome.needs.length} value${outcome.needs.length === 1 ? "" : "s"} needed`
                                  : "cannot build"}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {packageChoice && !packageChoice.ok && (
                  <p className="step-note">
                    Nothing can be built yet: the reading is missing {packageChoice.blockedBy.join(" and ")}. Picking a
                    package re-reads the datasheet for it, which often fills that in.
                  </p>
                )}
              </section>
            )}

            {/* 5. EXPORT ------------------------------------------------------ */}
            <section className="step">
              <h2 className="step-title">
                <span className="step-n">{exportStep}</span> Export
              </h2>

              <div className="formats">
                {formatOptions.map((option) => (
                  <label
                    key={option.value}
                    className={`fmt${selectedFormat === option.value ? " fmt-on" : ""}${option.ready ? "" : " fmt-off"}`}
                  >
                    <input
                      type="radio"
                      name="format"
                      value={option.value}
                      checked={selectedFormat === option.value}
                      disabled={!option.ready}
                      onChange={() => setSelectedFormat(option.value)}
                    />
                    <span className="fmt-name">{option.label}</span>
                    <span className="fmt-note">{option.note}</span>
                  </label>
                ))}
              </div>

              <div className="export-row">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  onClick={() => handleExport()}
                  disabled={busy || !part.partNumber.value}
                >
                  Build library
                </button>
                {Object.entries(installAnswers).map(([field, value]) => (
                  <span className="remembered" key={field}>
                    {INSTALL_LABELS[field] ?? field} {value} mm, remembered.{" "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setInstallAnswers((current) => {
                          const next = { ...current };
                          delete next[field];
                          return next;
                        });
                        try {
                          window.localStorage.removeItem(`${INSTALL_KEY_PREFIX}${field}`);
                        } catch {
                          // The in-memory value is already gone.
                        }
                      }}
                    >
                      change
                    </button>
                  </span>
                ))}
              </div>

              {/* Each question, beside the page its answer is printed on. */}
              {shownNeeds.length > 0 && pendingNeeds.length === 0 && (
                <p className="step-note">
                  {shownNeeds.length === 1
                    ? "One number is missing before this can be built."
                    : `${shownNeeds.length} numbers are missing before this can be built.`}{" "}
                  Answer them here and the build will go straight through.
                </p>
              )}
              {shownNeeds.map((need) => {
                const page = need.page ?? (need.field === "formedLeadSpanMm" ? null : drawingPage);
                return (
                  <div key={need.field} className="ask">
                    <div className="ask-left">
                      <label className="ask-label" htmlFor={`need-${need.field}`}>
                        {need.label}
                        {need.unit === "mm" && <span className="unit"> mm</span>}
                      </label>
                      <p className="ask-why">{need.why}</p>
                      <div className="ask-row">
                        <input
                          id={`need-${need.field}`}
                          type={need.unit === "counts" ? "text" : "number"}
                          min={need.unit === "mm" ? "0" : "1"}
                          step={need.unit === "mm" ? "0.01" : "1"}
                          {...(need.unit === "mm" ? { max: MAX_LEAD_SPAN_MM } : {})}
                          value={needValues[need.field] ?? ""}
                          placeholder={need.unit === "counts" ? "6,6,6,5" : need.unit === "count" ? "2" : "1.55"}
                          onChange={(event) =>
                            setNeedValues((current) => ({ ...current, [need.field]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void handleSupplyNeed(need, needValues[need.field] ?? "");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => handleSupplyNeed(need, needValues[need.field] ?? "")}
                        >
                          Use this
                        </button>
                      </div>
                      {need.scope === "install" && (
                        <p className="ask-scope">
                          Asked once. This belongs to your assembly line rather than to this part, so it is remembered for
                          every part after this one.
                        </p>
                      )}
                    </div>
                    <div className="ask-right">
                      <PageImage image={imageFor(page)} caption={need.pageLabel ?? "Package outline"} page={page} />
                    </div>
                  </div>
                );
              })}
            </section>

            {/* 6. THE RECORD --------------------------------------------------- */}
            <section className="step">
              <button
                type="button"
                className="disclose"
                onClick={() => setShowRecord(!showRecord)}
                aria-expanded={showRecord}
              >
                <span className="rev-caret">{showRecord ? "▾" : "▸"}</span>
                {showRecord ? "Hide" : "Show"} the full record
                <span className="disclose-sub">{pins.length} pins, every dimension, and where each value came from</span>
              </button>

              {showRecord && (
                <div className="record">
                  <div className="record-col">
                    <h3>Package</h3>
                    <table className="facts">
                      <tbody>
                        <Row label="Body length" unit="mm" field={part.dimensions.bodyLengthMm} />
                        <Row label="Body width" unit="mm" field={part.dimensions.bodyWidthMm} />
                        <Row label="Body height" unit="mm" field={part.dimensions.bodyHeightMm} />
                        <Row label="Pitch" unit="mm" field={part.dimensions.pitchMm} />
                        <Row label="Lead span" unit="mm" field={part.dimensions.leadSpanMm} />
                        <Row label="Lead width" unit="mm" field={part.dimensions.leadWidthMm} />
                        <Row label="Seated foot" unit="mm" field={part.dimensions.leadContactMm} />
                        <Row label="Lead form" field={part.dimensions.leadForm} />
                        <Row label="Sides with leads" field={part.dimensions.leadSides} />
                      </tbody>
                    </table>

                    <h3>Printed footprint</h3>
                    <table className="facts">
                      <tbody>
                        <Row label="Land length" unit="mm" field={part.dimensions.landPadLengthMm} />
                        <Row label="Land width" unit="mm" field={part.dimensions.landPadWidthMm} />
                        <Row label="Centre span" unit="mm" field={part.dimensions.landSpanMm} />
                        <Row label="Mask expansion" unit="mm" field={part.dimensions.solderMaskExpansionMm} />
                        <Row label="Exposed pad" unit="mm" field={part.dimensions.thermalPadLengthMm} />
                        <Row label="Via drill" unit="mm" field={part.dimensions.thermalViaDiameterMm} />
                      </tbody>
                    </table>
                  </div>

                  <div className="record-col">
                    <h3>
                      Pins <span className="count">{pins.length}</span>
                    </h3>
                    {pins.length === 0 ? (
                      <p className="empty">No pin table was read from this datasheet.</p>
                    ) : (
                      <div className="pins-scroll">
                        <table className="pins">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Name</th>
                              <th>Type</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pins.map((pin, index) => (
                              <tr key={`${pin.number}-${index}`}>
                                <td className="num">
                                  <input
                                    value={pin.number}
                                    onChange={(event) => setPart(updatePin(part, index, "number", event.target.value))}
                                  />
                                </td>
                                <td>
                                  <input
                                    value={pin.name}
                                    onChange={(event) => setPart(updatePin(part, index, "name", event.target.value))}
                                  />
                                </td>
                                <td className="meta">{pin.electricalType}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {part.notes.length > 0 && (
                <ul className="notes">
                  {part.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      <footer className={`status${busy ? " status-busy" : ""}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        {status}
      </footer>
    </div>
  );
}
