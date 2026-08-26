"use client";

import { useEffect, useMemo, useState } from "react";
import { isUntraceable, userEdited } from "../lib/provenance";
import type { Extracted, ExportFormat, LeadWidth, PartRecord, PinRecord } from "../lib/types";
// Runtime import, and safe in the browser bundle: `packagevariants.ts` imports
// nothing at all and is pure string work over designators.
import { declaredLeadCount, pinTableFor } from "../lib/packagevariants";
// Type-only import: erased at compile time, so no retrieval-layer runtime code
// (node:crypto, the resolvers) is pulled into the client bundle.
import type { DeploymentMode } from "../lib/retrieval";
// Type-only for the same reason: `exporters.ts` reaches the CAD generators.
import type { PackageChoice, PackageOption, RequiredInput } from "../lib/exporters";
import {
  SETTINGS_FIELDS,
  missingRequired,
  outOfRange,
  parseSettings,
  settingsComplete,
  type ForgeSettings
} from "../lib/settings";
import { labelForField, type ReviewItem } from "../lib/review";
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
    leadSpanCrossMm: nothing<LeadWidth>(),
    leadContactMm: nothing<LeadWidth>(),
    thermalPadLengthMm: nothing<number>(),
    thermalPadWidthMm: nothing<number>(),
    landPadLengthMm: nothing<number>(),
    landPadWidthMm: nothing<number>(),
    landSpanMm: nothing<number>(),
    landSpanCrossMm: nothing<number>(),
    leadSides: nothing<1 | 2 | 4>(),
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
 * Where an `install`-scoped answer is remembered. Survives the session deliberately.
 *
 * A PREFIX rather than one key per field. There are two of these now, the formed
 * lead span and the formed foot, both made by the same forming die, and the
 * single-key version silently overwrote one with the other. Keying by field name
 * also means a third install-scoped question needs no change here, which is the
 * "fixed in one place, not the other" trap this codebase has hit repeatedly.
 */
const INSTALL_KEY_PREFIX = "forge.install.";

/**
 * Where the installation's settings live.
 *
 * The same store as the install-scoped answers above and deliberately so: the
 * forming-die numbers ARE settings, and were being collected twice, once on the
 * screen and once mid-parse as a question. `settingsFromStore` reads both so a
 * value entered either way is seen by the other.
 */
const SETTINGS_KEY = "forge.settings";

/** Field names whose answers belong to the assembly line rather than the part. */
const INSTALL_FIELDS = ["formedLeadSpanMm", "formedLeadContactMm"] as const;

/** Human labels for the remembered-value notice. */
const INSTALL_LABELS: Record<string, string> = {
  formedLeadSpanMm: "Formed lead span",
  formedLeadContactMm: "Formed foot length"
};

/** Largest span the export route accepts, mirrored so the UI refuses it first. */
const MAX_LEAD_SPAN_MM = 200;

/**
 * The route's own bound on the formed FOOT, which is far tighter than the span.
 *
 * A foot is a feature of one lead rather than a distance across the package, so
 * `/api/export` caps it at 5 mm. This screen validated every millimetre answer
 * against the span's 200, so 8 was accepted here and rejected there with a
 * message about a limit the user had never been shown. Mirrored per field
 * rather than one number for all of them, which is what let the two drift.
 */
const MAX_FORMED_CONTACT_MM = 5;

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
          : // NOT "no page of this datasheet answers this". What is known is that
            // the value carries no citation, which is a fact about the reading.
            "This value was not located on any page, so there is no page to show."}
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
  // The table was edited by hand, so the array's provenance changes with it,
  // INCLUDING the citation. This used to pass `next.pins.citation` through, so
  // a pin table a person had retyped went on claiming it was read from the page
  // the model found it on. See `userEdited`.
  next.pins = userEdited(pins);
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
  // NOT "this datasheet draws no pinout for it". Reading it again and finding
  // nothing is not proof the document draws nothing; it is proof of what this
  // read returned.
  return `Reading this datasheet again for ${designator} found no pinout.`;
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

  /**
   * The package the USER picked, held beside the record rather than written into it.
   *
   * `/api/export` applies `asPackage` only when the request names a package, and
   * this screen never named one: it wrote the chosen designator into
   * `part.packageType` instead and posted the record. So the one function that
   * knows what relabelling costs (blank every dimension read for the old
   * package, take the new package's own pin table, keep the lead-count check)
   * ran in the CHOOSER, which computes the button's label, and never on the
   * export the button leads to. A part chosen this way exported with one
   * package's name over another's body, land pattern and outline code, which is
   * the failure this product is most exposed to because every input is
   * individually valid.
   *
   * Held separately because the record says what was READ and the request says
   * what the caller is HOLDING. Merging the two is what made `asPackage`
   * short-circuit: it returns the record unchanged when the designator it is
   * given already matches, which is right, and was being handed a designator the
   * UI had just written in.
   */
  const [chosenPackage, setChosenPackage] = useState<string | null>(null);

  // Values the export asked for. Empty unless the last attempt came back 422.
  const [pendingNeeds, setPendingNeeds] = useState<RequiredInput[]>([]);
  /**
   * The export's refusal, when it named the values it could not resolve.
   *
   * `/api/export` answers a record it cannot build from with 422 and the exact
   * field paths, under `missing` for values nothing read and `untraceable` for
   * values a model produced but could not point at a page for. THE SCREEN THREW
   * BOTH LISTS AWAY. It handled only `INPUT_REQUIRED`, and everything else fell
   * through to a generic error, so the user read "required values were not
   * extracted from the datasheet. Fill them in before exporting." and was told
   * to fill in something the sentence would not name.
   *
   * Reported here in full, because the two cases need opposite things from a
   * person: an untraceable value is on the record and needs checking against
   * the page it claims, and a missing one was never read at all.
   */
  const [exportBlocked, setExportBlocked] = useState<
    { kind: "missing" | "untraceable"; fields: string[] } | null
  >(null);
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

  // THE INSTALLATION'S SETTINGS, and whether the first run is allowed yet.
  //
  // `settingsReady` starts false so the gate cannot flash open on first paint
  // and let a datasheet through before the store has been read.
  /**
   * The datasheet the settings gate turned away, kept so it can be run once the
   * gate opens.
   *
   * ## The dead end this closes
   *
   * A first-time user's first action is to choose a datasheet. The gate refuses
   * it, correctly, and asks for the two forming-die numbers. They answer, save,
   * and nothing happens: the file they chose is still named in the drop target,
   * which invites "click to replace", and choosing THE SAME FILE again fires no
   * `change` event at all, because the input's value has not changed. The screen
   * then sits on the refusal message with no way forward but a page reload.
   *
   * Running it here is not an assumption about what they want. They already
   * asked for this file; the only reason it did not run is a question that has
   * now been answered.
   */
  const [heldByGate, setHeldByGate] = useState<{ file: File; packageType?: string } | null>(null);
  const [settings, setSettings] = useState<ForgeSettings>({});
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The last action that failed for a reason worth trying again, or null.
   *
   * A drawing pass that could not be run is not a verdict on the document, so
   * the user is offered the same attempt rather than an empty record and a
   * sentence about it. See `SecondPassFailedError`.
   */
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const restored: Record<string, number> = {};
      for (const field of INSTALL_FIELDS) {
        const saved = window.localStorage.getItem(`${INSTALL_KEY_PREFIX}${field}`);
        const parsed = saved === null ? NaN : Number(saved);
        if (Number.isFinite(parsed) && parsed > 0) restored[field] = parsed;
      }
      if (Object.keys(restored).length > 0) setInstallAnswers(restored);

      // The two stores are READ TOGETHER. A customer who answered the forming
      // die mid-parse before this screen existed must not be asked again on the
      // screen, and vice versa: they are the same two numbers.
      const stored = window.localStorage.getItem(SETTINGS_KEY);
      const parsedSettings = parseSettings({ ...restored, ...(stored ? JSON.parse(stored) : {}) });
      setSettings(parsedSettings);
      setSettingsOpen(!settingsComplete(parsedSettings));
    } catch {
      // A blocked localStorage costs one re-entry, not the export. The gate then
      // stays shut, which is the safe side: it asks rather than assumes.
      setSettingsOpen(true);
    }
    setSettingsReady(true);
  }, []);

  /** Persist and apply. Called only from the settings screen's Save. */
  function saveSettings(next: ForgeSettings) {
    const clean = parseSettings(next);
    // WHAT WAS THROWN AWAY, AND WHY. `parseSettings` drops an out-of-range
    // number, which is right, and used to do it in silence: the box still
    // showed the value, the gate still said the field was needed, and the two
    // messages never met. Said here rather than inside `parseSettings`, which
    // is shared with the server and has no screen to talk to.
    const rejected = outOfRange(next as Record<string, unknown>);
    if (rejected.length > 0) {
      setStatus(
        rejected
          .map((field) => `${field.label} must be between 0 and ${field.max} mm.`)
          .join(" ")
      );
    }
    setSettings(clean);
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
      // Kept in step with the per-question store so neither goes stale.
      for (const field of INSTALL_FIELDS) {
        const value = clean[field as keyof ForgeSettings];
        if (typeof value === "number") window.localStorage.setItem(`${INSTALL_KEY_PREFIX}${field}`, String(value));
      }
    } catch {
      // Unsaved settings still apply to this session.
    }
    setInstallAnswers((current) => ({
      ...current,
      ...(clean.formedLeadSpanMm !== undefined ? { formedLeadSpanMm: clean.formedLeadSpanMm } : {}),
      ...(clean.formedLeadContactMm !== undefined ? { formedLeadContactMm: clean.formedLeadContactMm } : {})
    }));
    if (!settingsComplete(clean)) return;
    setSettingsOpen(false);

    // The gate is open, so run whatever it turned away. `clean` is passed
    // explicitly for the same reason `handleExport` passes its answers: the
    // state set above is not visible to a handler queued from this one, and
    // `handleFile` would read the settings it had before the Save.
    const held = heldByGate;
    if (held && rejected.length === 0) {
      setHeldByGate(null);
      void handleFile(held.file, held.packageType, clean);
    }
  }

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

  /** What the export will actually build for: the caller's choice, else the reading. */
  const activePackage = chosenPackage ?? part.packageType.value;

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
    const chosen = packageChoice.options.find((option) => option.designator === activePackage);
    // The resolved package where there is one, otherwise the only offer. With
    // several unresolved packages the questions differ per package, and showing
    // one package's questions as if they were the part's would be a guess.
    const option = chosen ?? (packageChoice.options.length === 1 ? packageChoice.options[0] : undefined);
    return option?.status === "needs-input" ? option.needs : [];
  }, [packageChoice, activePackage]);

  const shownNeeds = pendingNeeds.length > 0 ? pendingNeeds : knownNeeds;

  /**
   * The outstanding questions, gathered under the page each is answered from.
   *
   * Grouped rather than listed because the drawing is the expensive part of the
   * row and it is shared: every dimension a package outline is missing is read
   * off that one outline. See the note at the render site for what this cost.
   */
  const needsByPage = useMemo(() => {
    const groups = new Map<string, { page: number | null; needs: RequiredInput[] }>();
    for (const need of shownNeeds) {
      const page = need.page ?? (need.field === "formedLeadSpanMm" ? null : drawingPage);
      const key = String(page ?? "none");
      const existing = groups.get(key);
      if (existing) existing.needs.push(need);
      else groups.set(key, { page, needs: [need] });
    }
    return [...groups.entries()].map(
      ([key, group]) => [key, group.page, group.needs] as [string, number | null, RequiredInput[]]
    );
  }, [shownNeeds, drawingPage]);

  /**
   * Whether clicking a package will RE-READ the datasheet, which costs real time
   * and a real model call.
   *
   * `handlePackageChoice` takes one of three routes, and two of them are free:
   * the document already tabulates that package's pinout, or the record's
   * pinout is complete and does not contradict the designator. The third
   * re-reads the whole document for the named package, which is upward of a
   * minute and is charged.
   *
   * Which route a given card takes depends on whether the document happened to
   * print a per-package pin table for it, and the user cannot see that. So a
   * card reading "cannot build" invited a click that felt like asking a
   * question and was actually the most expensive action on the screen. Found
   * 2026-08-24 sweeping the chooser: on an AD8628, TSOT-23 and SOT-23 are both
   * labelled "cannot build", and one is free while the other re-reads.
   *
   * Mirrors that function deliberately. If the two ever disagree the label lies
   * about what the button does, so they are written to be read side by side.
   */
  const willReRead = (designator: string): boolean => {
    if (pinTableFor(part.packagesInThisDocument, designator)?.pins) return false;
    const held = part.pins.value ?? [];
    const complete = held.length > 0 && part.pinCount.value !== null;
    const declared = declaredLeadCount(designator);
    const contradicts = complete && declared !== null && declared !== part.pinCount.value;
    if (complete && !contradicts) return false;
    return origin !== null;
  };

  const failedChecks = checks.filter((check) => check.state === "fail");
  const openChecks = checks.filter((check) => check.state !== "pass");
  const blockingReview = review.filter((item) => item.blocking);
  const sourceUrl = formatSourceUrl(part.sourceUrl);
  const pins = part.pins.value ?? [];
  /**
   * THE ONE THING THE SCREEN HAS TO SAY AFTER A READ.
   *
   * ## What this replaces
   *
   * A finished read used to produce five numbered steps at once: what was read,
   * worth a look, package, export, and the record. On an LMP7704-SP that is a
   * thirteen-item review list and a wall of dimensions, presented as a form to
   * work through. Reported 2026-08-24 by the first person to use it: "I don't
   * know what I'm looking at."
   *
   * The screen owes a person three answers, in this order: what part is this,
   * can I have my library, and what do I do next. Everything else is detail
   * they may want and should not have to wade through.
   *
   * ## Why the order is what it is
   *
   * The states are ranked by what BLOCKS the build, hardest first, because only
   * the first one is actionable. Offering someone a package chooser and eight
   * questions and a review list at once is three next-actions, which is none.
   *
   * The package choice leads because it is the only one the product genuinely
   * cannot make for the user: a footprint is per package, and this document
   * describes several. Questions come next because they have answers. The
   * review list comes last because it blocks nothing until the export says so.
   */
  const verdict = useMemo((): {
    tone: "ready" | "choose" | "ask" | "check";
    headline: string;
    detail: string;
    /** The thing the detail line is telling them to do, where there is one. */
    action?: "re-read";
  } => {
    // THE RECORD ITSELF CANNOT BUILD, whatever is chosen. `packageChoice.ok`
    // is false when the reading is short of something no package selection can
    // supply, and `blockedBy` names it.
    //
    // Checked FIRST, and it is the reason this state exists. Without it the
    // card said "Ready to build" on an LMP7704-SP whose pinout had not been
    // read, and the export then refused with "this datasheet is missing values
    // the footprint needs". A verdict that contradicts the button beneath it is
    // worse than no verdict: it spends the user's trust and then their time.
    // Caught by `bench:browser` on 2026-08-25, one run after the card was added.
    if (packageChoice && !packageChoice.ok) {
      const named = packageChoice.blockedBy.map(labelForField);
      // BLAME THE RIGHT LAYER.
      //
      // "This datasheet has no pinout" and "we read one and refused it" are
      // different facts. The card said the first for both, so every encounter
      // with a discard was filed as the model failing, and a code defect
      // survived from 2026-08-10 to 2026-08-25 being reported as a bad read.
      // The reader writes the discard onto the record; this reads it back.
      const discarded = part.notes.find((note) => /pin table that was discarded/.test(note));
      if (discarded && packageChoice.blockedBy.includes("pins")) {
        return {
          tone: "check",
          headline: "A pinout was read and then refused, so nothing can be built yet.",
          detail: `${discarded} Reading again often returns a table that passes.`,
          action: "re-read" as const
        };
      }
      return {
        tone: "check",
        headline: `Not enough was read to build anything: ${named.join(" and ")}.`,
        detail:
          offeredVariants.length > 1
            ? "Choosing the exact package below re-reads the datasheet for it, which usually finds them."
            : "A read varies: the same document can give up its pinout on a second pass. Failing that, a different revision often does.",
        // TOLD WHAT TO DO, AND GIVEN THE MEANS.
        //
        // This said "reading the datasheet again sometimes finds them" and put
        // nothing on the screen to do it with, so the only route was to scroll
        // back, re-pick the same file, and press Read. Reported 2026-08-25:
        // "what am I supposed to do with this?" Advice a screen will not act on
        // is the dead end the settings gate already was.
        ...(offeredVariants.length > 1 ? {} : { action: "re-read" as const })
      };
    }
    if (offeredVariants.length > 1 && chosenPackage === null && part.packageType.value === null) {
      return {
        tone: "choose",
        // COUNTS WHAT WAS READ. "This datasheet describes N" asserts the list is
        // complete, and it is the list this run produced.
        headline: `Which package? ${offeredVariants.length} were read from this datasheet.`,
        detail:
          "A footprint is a manufacturing instruction for one package, so this is the one choice nothing can make for you."
      };
    }
    if (shownNeeds.length > 0) {
      return {
        tone: "ask",
        headline:
          shownNeeds.length === 1
            ? "One number is needed before this can be built."
            : `${shownNeeds.length} numbers are needed before this can be built.`,
        // NOT "the datasheet does not print them". We do not know that; we know
        // we did not read them. See `askForLandPattern` in `exporters.ts`.
        detail: "They were not read from this datasheet, so they are asked rather than invented."
      };
    }
    if (blockingReview.length > 0) {
      return {
        tone: "check",
        headline: `${blockingReview.length} ${blockingReview.length === 1 ? "value needs" : "values need"} checking first.`,
        detail: "These were read but could not be located on a page, so they cannot be signed off unchecked."
      };
    }
    return {
      tone: "ready",
      headline: "Ready to build.",
      detail:
        review.length > 0
          ? `${review.length} ${review.length === 1 ? "value is" : "values are"} worth a look first, but nothing is blocking.`
          : "Everything the footprint needs was read from the datasheet."
    };
  }, [
    packageChoice,
    offeredVariants.length,
    chosenPackage,
    part.packageType.value,
    shownNeeds.length,
    blockingReview.length,
    review.length
  ]);

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
      setChosenPackage(null);
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

  async function handleFile(file: File | null, packageType?: string, using: ForgeSettings = settings) {
    setSelectedFile(file);
    if (!file) return;

    // THE FIRST RUN IS GATED ON THE SETTINGS, per RULES.md 3.
    //
    // Enforced here rather than only by disabling the input: a drop target, a
    // paste and a lookup all reach this function, and a rule written on one of
    // three doors is not a rule. Fields a published standard answers are not
    // part of this; only the ones nothing else can answer.
    if (!settingsComplete(using)) {
      setSettingsOpen(true);
      // HELD, not dropped. See `heldByGate`.
      setHeldByGate({ file, packageType });
      setStatus("Set up your assembly line first, then this datasheet runs on its own.");
      return;
    }
    setHeldByGate(null);

    setBusy(true);
    setRetry(null);
    setStatus(packageType ? `Re-reading ${file.name} as ${packageType}…` : `Reading ${file.name}…`);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (packageType) formData.append("packageType", packageType);

      const response = await fetch("/api/parse", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) {
        // RETRYABLE MEANS THE DOCUMENT WAS FINE AND WE WERE NOT.
        //
        // The server says which failures are worth repeating; the UI does not
        // guess from the status code. A 503 from the drawing pass keeps the
        // file in hand and offers the same attempt, because re-uploading and
        // hoping was the only recourse before this.
        if (payload.retryable || payload.code === "MODEL_UNAVAILABLE") {
          setRetry(() => () => void handleFile(file, packageType));
        }
        throw new Error(payload.error || "Could not read that datasheet.");
      }

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

    // THE CHOICE IS RECORDED, THE RECORD IS NOT REWRITTEN.
    //
    // Every branch below used to write the designator into `part.packageType`,
    // and two of them also wrote the pins. That is `asPackage`'s job, done a
    // second time and less completely: it left every dimension read for the
    // PREVIOUS package in place under the new package's name, and it made the
    // export request name no package at all, so the real rule never ran. See
    // `chosenPackage`.
    // AND EVERY NUMBER TYPED FOR THE PREVIOUS PACKAGE IS DROPPED.
    //
    // `supplied` survived a package change, so a land span answered for the SOIC
    // was still being sent when the user switched to the QFN. That is the same
    // mistake `asPackage` exists to prevent, made one layer up: those numbers
    // were read off, or measured for, a different package's drawing, and a
    // footprint built partly from one package and partly from another is wrong
    // in a way nothing downstream can see.
    //
    // The install-scoped answers are a different thing and are NOT cleared
    // elsewhere for the same reason: a forming die belongs to the assembler and
    // not to the package. They are not in this map.
    setSupplied({});

    const table = pinTableFor(part.packagesInThisDocument, designator);
    // Rows, specifically. An entry may carry this package's MEASUREMENTS and no
    // pinout, which is a complete answer about the drawings and says nothing
    // about the pins, so it is not what this branch is announcing.
    if (table?.pins) {
      setChosenPackage(designator);
      setStatus(
        `Package set to ${designator}. The ${table.pins.length}-pin table this datasheet prints for it will be used, ` +
          `and the dimensions read for the other package are dropped.`
      );
      return;
    }

    const declared = declaredLeadCount(designator);
    const contradicts = complete && declared !== null && declared !== part.pinCount.value;

    if (complete && !contradicts) {
      setChosenPackage(designator);
      setStatus(`Package set to ${designator}. The pinout was already read, so it is kept.`);
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
    setChosenPackage(designator);
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
          // The package the caller is HOLDING, when they picked one. This is what
          // makes `/api/export` apply `asPackage`, which is the only place the
          // relabelling rule is written.
          ...(chosenPackage ? { packageType: chosenPackage } : {}),
          // Every answered question, under the field name the refusal used.
          ...answers,
          // Install-scoped answers last, so a remembered value is sent even on
          // an export the user started without answering anything this time.
          ...install,
          // THE INSTALLATION'S SETTINGS. Until 2026-08-19 the density level had
          // no way to reach the server at all: `ExportOptions.densityLevel` had
          // existed since the generator did and no caller ever set it, so every
          // export in this product's life was built at the standard's nominal
          // whatever the customer chose.
          settings
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
        // THE OTHER TWO REFUSALS NAME THEIR FIELDS TOO. See `exportBlocked`.
        if (payload?.code === "UNTRACEABLE_EXTRACTION" && Array.isArray(payload.untraceable)) {
          setExportBlocked({ kind: "untraceable", fields: payload.untraceable as string[] });
          setStatus("Some values could not be located in the datasheet.");
          return;
        }
        if (payload?.code === "INCOMPLETE_EXTRACTION" && Array.isArray(payload.missing)) {
          setExportBlocked({ kind: "missing", fields: payload.missing as string[] });
          setStatus("This datasheet is missing values the footprint needs.");
          return;
        }
        // A NAME THE CHOSEN FORMAT CANNOT WRITE. Not a fault in the record, and
        // not something to answer: another format has no such limit, so the one
        // useful thing to say is which one.
        if (payload?.code === "FORMAT_CANNOT_ENCODE") {
          const alternative = (payload.availableFormats as string[] | undefined)?.[0];
          setStatus(
            alternative
              ? `${payload.error} Try ${alternative.toUpperCase()}, which has no such limit.`
              : payload.error
          );
          return;
        }
        throw new Error(payload?.error || "Export failed.");
      }

      setExportBlocked(null);
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
    // `userEdited` rather than a patch of value/confidence/method: `withField`
    // MERGES, so a patch that does not mention the citation keeps the model's,
    // and the corrected number then cites the page the wrong number came from.
    setPart((record) => withField(record, item.field, userEdited(value)));
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
      // One count per SIDE, for the arrangements this generator builds: 1, 2 or
      // 4. This demanded exactly four, so a two-sided package with unequal rows
      // had a question it could not answer here.
      if (!/^\d{1,3}(?:,\d{1,3})?$|^\d{1,3}(?:,\d{1,3}){3}$/.test(text)) {
        setStatus("Enter one count per side, separated by commas, e.g. 6,6,6,5.");
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
      const ceiling = need.field === "formedLeadContactMm" ? MAX_FORMED_CONTACT_MM : MAX_LEAD_SPAN_MM;
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > ceiling) {
        setStatus(`Enter ${need.label.toLowerCase()} in mm, greater than 0 and no more than ${ceiling}.`);
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
        {/* 0. SETTINGS -------------------------------------------------------
            Shown before anything else on a fresh install, and reachable after.
            RULES.md 3: a value no datasheet states and that differs between one
            user's line and another's is a setting, and it is settled ONCE rather
            than asked per part. Measured 2026-08-19: seven parts of the tuned
            corpus were blocked on the two forming-die numbers alone. */}
        {settingsReady && settingsOpen && (
          <section className="step" aria-labelledby="settings-title">
            <div className="step-head">
              <span className="step-eyebrow">First</span>
              <h2 className="step-title" id="settings-title">Your assembly line</h2>
            </div>
            <p className="hint">
              {settingsComplete(settings)
                ? "These apply to every part you build."
                : "Set these before your first datasheet. They describe your process, so no datasheet can answer them."}
            </p>

            <div className="settings">
              {SETTINGS_FIELDS.map((field) => {
                const current = settingsDraft[field.key] ?? (settings[field.key] ?? "").toString();
                const required = field.standard === null;
                return (
                  <label className="setting" key={field.key}>
                    <span className="setting-label">
                      {field.label}
                      {required ? <em className="req"> required</em> : null}
                    </span>
                    {field.key === "densityLevel" ? (
                      <select
                        value={current}
                        onChange={(event) => setSettingsDraft({ ...settingsDraft, [field.key]: event.target.value })}
                      >
                        <option value="">Use the standard (IPC-7351B, level B)</option>
                        <option value="A">A, most copper, for hand rework</option>
                        <option value="B">B, nominal</option>
                        <option value="C">C, least copper, for dense assemblies</option>
                      </select>
                    ) : field.key === "footprintSource" ? (
                      <select
                        value={current}
                        onChange={(event) => setSettingsDraft({ ...settingsDraft, [field.key]: event.target.value })}
                      >
                        <option value="">Use the manufacturer&apos;s own pattern where the datasheet prints one</option>
                        <option value="datasheet-first">The manufacturer&apos;s pattern first</option>
                        <option value="standard-always">Always compute from IPC-7351B</option>
                      </select>
                    ) : (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        // The same bound the export route enforces, so the box
                        // refuses before the Save does.
                        max={field.max}
                        inputMode="decimal"
                        placeholder={field.max === undefined ? "mm" : `mm, up to ${field.max}`}
                        value={current}
                        onChange={(event) => setSettingsDraft({ ...settingsDraft, [field.key]: event.target.value })}
                      />
                    )}
                    <span className="setting-why">
                      {field.why}
                      {field.standard ? ` Leave blank and we use ${field.standard}.` : ""}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="settings-actions">
              <button
                type="button"
                onClick={() => {
                  const merged: Record<string, unknown> = { ...settings };
                  for (const field of SETTINGS_FIELDS) {
                    const raw = settingsDraft[field.key];
                    if (raw === undefined) continue;
                    if (raw === "") delete merged[field.key];
                    else merged[field.key] = field.unit === "mm" ? Number(raw) : raw;
                  }
                  saveSettings(merged as ForgeSettings);
                }}
              >
                Save settings
              </button>
              {settingsComplete(settings) && (
                <button type="button" className="ghost" onClick={() => setSettingsOpen(false)}>
                  Close
                </button>
              )}
              {missingRequired(settings).length > 0 && (
                <span className="hint">
                  {missingRequired(settings).length} still needed before the first datasheet.
                </span>
              )}
            </div>
          </section>
        )}

        {settingsReady && !settingsOpen && (
          <p className="hint">
            <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
              Assembly line settings
            </button>
          </p>
        )}

        {/* 1. SOURCE --------------------------------------------------------- */}
        <section className="step">
          <div className="step-head">
            <span className="step-eyebrow">Start</span>
            <h2 className="step-title">Datasheet</h2>
          </div>

          <div className="source">
            <div className="source-file">
            <label className="drop" htmlFor="datasheet-upload">
              <input
                id="datasheet-upload"
                type="file"
                accept="application/pdf"
                onChange={(event) => {
                  const chosen = event.target.files?.[0] ?? null;
                  // CHOOSING A FILE NO LONGER STARTS THE READ. See the button
                  // below: reading takes over a minute and costs a model call,
                  // so it is begun deliberately rather than by the side effect
                  // of picking a file.
                  // CLEARED, so the SAME file can be chosen twice.
                  //
                  // A file input fires `change` only when its value changes, so
                  // re-picking the file already in it is silent. That is not a
                  // corner case here: anything that ends a run without a record
                  // (the settings gate, a parse that failed, a datasheet read as
                  // the wrong package) leaves the user looking at "Click to
                  // replace" above the file they want to try again, and the
                  // click does nothing. Clearing the input costs nothing,
                  // because `selectedFile` is what the screen actually reads.
                  event.target.value = "";
                  setSelectedFile(chosen);
                }}
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

            {/* THE READ IS STARTED ON PURPOSE.
                Picking a file used to begin it immediately. That is the wrong
                shape for this operation twice over: it takes upward of a
                minute, and it spends a real model call, so a mis-click costs
                both. It also left nothing to press, which is what a person
                looks for after choosing a file. */}
            {selectedFile && (
              <div className="drop-go">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={busy}
                  onClick={() => void handleFile(selectedFile)}
                >
                  {busy ? "Reading…" : "Read this datasheet"}
                </button>
                <span className="drop-go-note">
                  Takes about a minute and a half. The datasheet is read by a model, page by page.
                </span>
              </div>
            )}
            </div>

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

        {/* WHAT IS HAPPENING, WHERE THE ANSWER WILL APPEAR.
            A read takes upward of a minute, and while it ran the screen was an
            empty page with a 13px line at the very bottom saying "Reading
            AD8628.pdf". Nothing moved. The honest reading of that screen is
            that the app has hung, and the only recourse a person has is to
            press the button again, which spends a second model call.

            This says the same thing the status bar says, in the place the eye
            is already looking and at a size that can be seen. */}
        {busy && (
          <section className="working" aria-live="polite">
            <span className="working-bar" aria-hidden="true" />
            <div>
              <p className="working-main">{status}</p>
              <p className="working-sub">
                The whole document goes to the model, then selected pages are rendered and read again.
                A minute and a half is normal. Leave this tab open.
              </p>
            </div>
          </section>
        )}

        {loaded && !busy && (
          <>
            {/* 2. THE ANSWER --------------------------------------------------
                One card: what the part is, whether it can be built, and the one
                thing to do next. See `verdict` for why this replaced four
                numbered steps competing for attention. */}
            <section className="step">
              <div className="result">
                <div className="result-id">
                  <span className="ident-part">{part.partNumber.value ?? "unknown part"}</span>
                  <span className="ident-sub">
                    {[part.manufacturer.value, activePackage].filter(Boolean).join(" · ") || "package not read"}
                  </span>
                </div>
                <dl className="identity-facts">
                  <div>
                    <dt>Pins</dt>
                    {/* THE COUNT AND THE PINOUT ARE DIFFERENT READINGS.
                        A package named "CFP (14)" states a count with no table
                        behind it. Printing a bare "14" beside a verdict saying
                        the pin names were never read, above a record disclosure
                        reading "0 pins", is three numbers disagreeing on one
                        screen. Reported 2026-08-25 from a screenshot. */}
                    <dd>
                      {part.pinCount.value === null
                        ? "—"
                        : (part.pins.value?.length ?? 0) === 0
                          ? `${part.pinCount.value}, no pinout`
                          : part.pinCount.value}
                    </dd>
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
                <p className={`result-verdict result-${verdict.tone}`}>
                  <span className="result-mark" aria-hidden="true">
                    {verdict.tone === "ready" ? "\u2713" : "\u2192"}
                  </span>
                  <span>
                    <strong>{verdict.headline}</strong>
                    <span className="result-detail">{verdict.detail}</span>
                    {verdict.action === "re-read" && origin !== null && (
                      <span className="result-action">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => {
                            if (origin.kind === "upload") void handleFile(origin.file);
                            else void handleLookup({ partNumber: origin.partNumber, manufacturer: origin.manufacturer });
                          }}
                        >
                          Read it again
                        </button>
                        <span className="result-action-note">Another minute and a half, and another model call.</span>
                      </span>
                    )}
                  </span>
                </p>
              </div>


              {/* FOLDED WHEN IT IS GOOD NEWS.
                  Four checks with their reasoning, open, directly under the
                  verdict. Every one of them passing is worth a line and not a
                  list: the reader has just been told what to do next and this
                  sat between them and doing it. A FAILED check is a different
                  thing and opens itself. */}
              {checks.length > 0 && (
                <details
                  className={`checks${failedChecks.length > 0 ? " checks-bad" : ""}`}
                  open={failedChecks.length > 0}
                >
                  <summary className="checks-head">
                    {failedChecks.length > 0
                      ? `${failedChecks.length} consistency check${failedChecks.length === 1 ? "" : "s"} failed`
                      : `All ${checks.filter((c) => c.state === "pass").length} runnable consistency checks passed`}
                  </summary>
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
                </details>
              )}
            </section>

            {/* 3. REVIEW, FOLDED UNLESS SOMETHING IS BLOCKING ------------------
                Thirteen items on an LMP7704-SP and seventeen on a DRV8825, every
                one a row to open and judge. Presented open, this WAS the screen
                after a read, and none of it blocks an export unless the value is
                untraceable. Open by default only when it does. See `verdict`. */}
            {review.length > 0 && (
              <details className="step reviews-fold" open={blockingReview.length > 0}>
                <summary className="step-head">
                  <span className="step-eyebrow">Worth a look</span>
                  <h2 className="step-title">
                    {review.length} {review.length === 1 ? "value" : "values"} read but not verified
                  </h2>
                  {blockingReview.length > 0 && (
                    <span className="badge">{blockingReview.length} blocking export</span>
                  )}
                </summary>
                <p className="step-note">
                  Open one to see the page it came from, then confirm it or correct it.
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
              </details>
            )}

            {/* 4. PACKAGE ----------------------------------------------------- */}
            {offeredVariants.length > 1 && (
              <section className="step">
                <div className="step-head">
                  <span className="step-eyebrow">Choose</span>
                  <h2 className="step-title">Which package</h2>
                </div>
                <p className="step-note">
                  Each card says what it would actually build, so the choice is made on the outcome rather than on the
                  name.
                </p>

                <ul className="packages">
                  {offeredVariants.map((variant) => {
                    const outcome: PackageOption | undefined = packageOutcomes.get(variant.designator);
                    const active = activePackage === variant.designator;
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
                          {willReRead(variant.designator) && (
                            <span className="pkg-cost">re-reads the datasheet, about a minute</span>
                          )}
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
              <div className="step-head">
                <span className="step-eyebrow">Build</span>
                <h2 className="step-title">Your library</h2>
              </div>

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
                  /* NOT OFFERED WHEN IT CANNOT SUCCEED.
                     `packageChoice.ok === false` means the reading is short of
                     something no choice on this screen can supply, so pressing
                     this can only produce a refusal. It sat directly under a
                     card saying "Not enough was read to build anything" as the
                     one big blue button on the page, which is the screen
                     telling a person to do a thing it has just told them will
                     not work. Reported 2026-08-25 from a screenshot. */
                  disabled={busy || !part.partNumber.value || (packageChoice ? !packageChoice.ok : false)}
                >
                  Build library
                </button>
                {/* Beside the button, not only in the card above it: a greyed
                    primary action with no reason next to it reads as a broken
                    screen rather than an honest one. */}
                {packageChoice && !packageChoice.ok && (
                  <span className="export-blocked-note">
                    Nothing to build yet. See above.
                  </span>
                )}
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

              {/* WHAT THE EXPORT REFUSED, AND WHAT TO DO ABOUT IT.
                  The two cases need opposite things from a person, so they are
                  not merged into one sentence about "required values". */}
              {exportBlocked && (
                <div className={`blocked blocked-${exportBlocked.kind}`}>
                  <p className="blocked-main">
                    {exportBlocked.kind === "untraceable"
                      ? "These were read, but could not be pointed at a page:"
                      : "These were never read from this datasheet:"}
                  </p>
                  <ul className="blocked-fields">
                    {exportBlocked.fields.map((field) => (
                      <li key={field}>{labelForField(field)}</li>
                    ))}
                  </ul>
                  <p className="blocked-why">
                    {exportBlocked.kind === "untraceable" ? (
                      <>
                        A value nobody can locate cannot be signed off, so it is not built into copper. Open each one
                        under <strong>Worth a look</strong> above, check it against the page it claims, and confirm it.
                      </>
                    ) : (
                      <>
                        A footprint is a manufacturing instruction, so these are not guessed.{" "}
                        {offeredVariants.length > 1
                          ? "Choosing the exact package above re-reads the datasheet for it, which usually finds them."
                          : "Reading the datasheet again sometimes finds them, and a different revision of the document often does."}
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* Each question, beside the page its answer is printed on. */}
              {shownNeeds.length > 0 && pendingNeeds.length === 0 && (
                <p className="step-note">
                  {shownNeeds.length === 1
                    ? "One number is missing before this can be built."
                    : `${shownNeeds.length} numbers are missing before this can be built.`}{" "}
                  Answer them here and the build will go straight through.
                </p>
              )}
              {/* ONE DRAWING PER GROUP, NOT ONE PER QUESTION.
                  Every question here is answered off the same package outline,
                  and each used to render its own copy of it. On an LMP7704-SP
                  that is eight questions carrying eight identical 613px images:
                  5764px of a 7118px page, the same drawing eight times. It read
                  as an endless form and it was mostly one picture repeated. */}
              {needsByPage.map(([pageKey, page, group]) => (
                <div key={pageKey} className="ask-group">
                  <div className="ask-list">
                    {group.map((need, position) => (
                      <div key={need.field} className="ask-row-full">
                        <label className="ask-label" htmlFor={`need-${need.field}`}>
                          {need.label}
                          {need.unit === "mm" && <span className="unit"> mm</span>}
                        </label>
                        {/* Said ONCE per run of questions that share it. Three
                            consecutive fields explaining themselves with the
                            same paragraph is three times the height and no more
                            information. */}
                        {need.why !== group[position - 1]?.why && <p className="ask-why">{need.why}</p>}
                        <div className="ask-row">
                          <input
                            id={`need-${need.field}`}
                            type={need.unit === "counts" ? "text" : "number"}
                            min={need.unit === "mm" ? "0" : "1"}
                            step={need.unit === "mm" ? "0.01" : "1"}
                            {...(need.unit === "mm"
                              ? { max: need.field === "formedLeadContactMm" ? MAX_FORMED_CONTACT_MM : MAX_LEAD_SPAN_MM }
                              : {})}
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
                            Asked once. This belongs to your assembly line rather than to this part, so it is
                            remembered for every part after this one.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="ask-page">
                    <PageImage
                      image={imageFor(page)}
                      caption={group[0]?.pageLabel ?? "Package outline"}
                      page={page}
                    />
                  </div>
                </div>
              ))}
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
                        <Row label="Lead span, other axis" unit="mm" field={part.dimensions.leadSpanCrossMm} />
                        <Row label="Lead width" unit="mm" field={part.dimensions.leadWidthMm} />
                        <Row label="Lead length" unit="mm" field={part.dimensions.leadLengthMm} />
                        <Row label="Seated foot" unit="mm" field={part.dimensions.leadContactMm} />
                        <Row label="Lead form" field={part.dimensions.leadForm} />
                        <Row label="Mounting" field={part.dimensions.mounting} />
                        <Row label="Lead diameter" unit="mm" field={part.dimensions.leadDiameterMm} />
                        <Row label="Sides with leads" field={part.dimensions.leadSides} />
                        <Row label="Leads per side" field={part.dimensions.leadsPerSide} />
                        <Row label="Empty grid position" field={part.dimensions.vacantLeadSlot} />
                        <Row label="Lead count" field={part.dimensions.leadCount} />
                      </tbody>
                    </table>

                    <h3>Printed footprint</h3>
                    {/*
                      EVERY dimension, because the disclosure above says so.
                      This showed fifteen of twenty-five and called itself "every
                      dimension". Two of the omissions mattered: the exposed pad
                      was one row labelled "Exposed pad", so a rectangular pad
                      read to a reviewer as a single number, and the cross-axis
                      centre span was invisible, so the value that places half a
                      quad's copper could not be seen or corrected.
                    */}
                    <table className="facts">
                      <tbody>
                        <Row label="Land length" unit="mm" field={part.dimensions.landPadLengthMm} />
                        <Row label="Land width" unit="mm" field={part.dimensions.landPadWidthMm} />
                        <Row label="Centre span" unit="mm" field={part.dimensions.landSpanMm} />
                        <Row label="Centre span, other axis" unit="mm" field={part.dimensions.landSpanCrossMm} />
                        <Row label="Mask expansion" unit="mm" field={part.dimensions.solderMaskExpansionMm} />
                        <Row label="Mask defined by" field={part.dimensions.solderMaskDefined} />
                        <Row label="Exposed pad length" unit="mm" field={part.dimensions.thermalPadLengthMm} />
                        <Row label="Exposed pad width" unit="mm" field={part.dimensions.thermalPadWidthMm} />
                        <Row label="Via drill" unit="mm" field={part.dimensions.thermalViaDiameterMm} />
                        <Row label="Via pitch" unit="mm" field={part.dimensions.thermalViaPitchMm} />
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

              {/* FOLDED AWAY BY DEFAULT.
                  These are the reader's own working notes, and they are written
                  in field paths: "dimensions.landSpanCrossMm",
                  "radiation.qmlClass", "vertex:gemini-3.6-flash looked for 35
                  field(s)". On a part that read cleanly this was thirty lines of
                  internal vocabulary under the export button, which is the bulk
                  of what made this screen feel like it had too much on it. Kept,
                  because they are the honest account of what the reader did and
                  did not find, and one click away. */}
              {part.notes.length > 0 && (
                <details className="notes-fold">
                  <summary>
                    What the reader reported <span className="count">{part.notes.length}</span>
                  </summary>
                  <ul className="notes">
                    {part.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          </>
        )}
      </main>

      <footer className={`status${busy ? " status-busy" : ""}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        {status}
        {retry !== null && !busy && (
          <button type="button" className="status-retry" onClick={retry}>
            Try again
          </button>
        )}
      </footer>
    </div>
  );
}
