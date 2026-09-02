"use client";

/**
 * ONE FRAME THAT GROWS.
 *
 * ## The shape, and why it is not four screens
 *
 * A session is one part, one read, one output. So the composer is a persistent
 * object rather than a page: on submit it settles to the top and the body grows
 * beneath it - identify, then the read, then the output - each replacing the
 * last INSIDE the same frame. There is exactly one place on screen where the
 * current state lives, and one control that means start over.
 *
 * Rejected: a chat log (history is not the artifact here, and the live content
 * sinks toward the fold), and a back/forward pager (intent and package steer the
 * read, so after it they are not editable; "back" could only mean discard, which
 * is a destructive action wearing a navigation arrow).
 *
 * ## Intent is chosen BEFORE the read, and that is the load-bearing decision
 *
 * The reader is field-directed: it is handed the fields and pages to go after.
 * A footprint wants the package outline drawing and one chosen package; a SPICE
 * model wants the specification table and no package at all, because a
 * macromodel describes the die. Asking afterwards means either over-reading both
 * or re-reading, and a re-read is the most expensive action in the product.
 *
 * Identification is separate and free: a deterministic text pass gives the part
 * number, the manufacturer, the page count and the packages named in the
 * ordering table with no model call. So the user chooses early without choosing
 * blind.
 *
 * ## What is NOT in this file
 *
 * Every handler in `src/app/page.tsx` - review, corrections, the confirm loop,
 * the export refusal path, install-scoped answers. They are unchanged and are
 * meant to be moved in behind the `TODO(merge)` markers below. This file owns
 * the shell and the phase machine, nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FootprintPreview from "../FootprintPreview";
import Onboarding from "./Onboarding";
import SettingsPanel from "./SettingsPanel";
import { loadAccount, loadSettings, saveAccount, saveSettings, type ForgeAccount } from "./account";
import { answersFromSettings } from "../../lib/settings";
import type { AccountDraft } from "./AccountForm";
import { clock, progressAt, stagesFor } from "../../lib/readprogress";
import type { Intent } from "../../lib/intent";
import type { ForgeSettings } from "../../lib/settings";
import type { ExportFormat, PartRecord } from "../../lib/types";
import type { FootprintGeometry } from "../../lib/geometry";
import type { PackageChoice } from "../../lib/exporters";

export type { Intent };

/**
 * Where the session is. Ordered, and only ever advanced by an action the user
 * took: nothing on this screen moves on its own except the read.
 */
type Phase = "empty" | "identified" | "reading" | "done";

/** The free pass. Deterministic, no model call, about a second. */
interface Identified {
  partNumber: string;
  manufacturer: string | null;
  pageCount: number;
  /** Designators named in the ordering table. Text only: no drawing behind them. */
  packages: Array<{ designator: string; family: string; leadCount: number | null }>;
  specPages: string | null;
  outlinePage: number | null;
  sha256: string;
  fileName: string;
}

const INTENTS: Array<{ key: Intent; label: string }> = [
  { key: "cad", label: "Symbol · footprint · 3D" },
  { key: "spice", label: "SPICE model" },
  { key: "both", label: "Both" }
];

/**
 * How often the read screen re-renders while it is running.
 *
 * Short enough that the bar is never seen standing still, long enough that it is
 * not a render per frame. The width carries a linear CSS transition of the same
 * length, so the motion between two samples is continuous rather than stepped.
 */
const TICK_MS = 250;

/**
 * The formats, and whether each has a generator behind it.
 *
 * Cadence says "not built" rather than shipping a renamed KiCad file, which is
 * what the whole bundle used to do. Mirrors `formatOptions` in
 * `src/app/page.tsx`; both read `exportFormats` from `src/lib/types.ts`.
 */
const FORMATS: Array<{ value: ExportFormat; label: string; note: string; ready: boolean }> = [
  { value: "kicad", label: "KiCad", note: ".kicad_sym · .kicad_mod · .step", ready: true },
  { value: "altium", label: "Altium", note: ".SchLib · .PcbLib", ready: true },
  { value: "cadence", label: "Cadence / OrCAD", note: "generator not built yet", ready: false }
];

/**
 * Why an export was refused, when it was refused for something nameable.
 *
 * `/api/export` answers with the exact fields rather than a sentence, and the
 * whole argument of the product is that it says which value it could not stand
 * behind. Printing "Export failed" over that would be throwing the answer away.
 */
type ExportRefusal =
  | { kind: "needs"; fields: string[] }
  | { kind: "untraceable"; fields: string[] }
  | { kind: "missing"; fields: string[] };

/**
 * One line beside the Read button: what the read is aimed at, and how long.
 *
 * It says what the click costs and what it goes after. The reason the intent is
 * chosen first is in the comment at the top of this file, where it belongs; it
 * was three sentences on screen and the user has to read them every session.
 */
function intentNote(intent: Intent): string {
  if (intent === "cad") return "Pin table and outline drawing. About 90 seconds.";
  if (intent === "spice") return "Specification table. About 90 seconds.";
  return "Both page sets, one pass. About 90 seconds.";
}

export default function SuiteWorkspace() {
  const [phase, setPhase] = useState<Phase>("empty");
  const [intent, setIntent] = useState<Intent>("cad");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [identified, setIdentified] = useState<Identified | null>(null);
  const [chosenPackage, setChosenPackage] = useState<string | null>(null);
  /** Milliseconds since the read began. Drives the bar and the stage list. */
  const [elapsedMs, setElapsedMs] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // The record, once the read has run. Same shape the existing workspace holds,
  // so every panel in `src/app/page.tsx` can be dropped in unchanged.
  const [part, setPart] = useState<PartRecord | null>(null);
  const [packageChoice, setPackageChoice] = useState<PackageChoice | null>(null);
  const [geometry, setGeometry] = useState<FootprintGeometry | null>(null);
  const [format, setFormat] = useState<ExportFormat>("kicad");
  const [refusal, setRefusal] = useState<ExportRefusal | null>(null);

  /**
   * THE INSTALLATION, READ ONCE ON MOUNT.
   *
   * `ready` is not decoration. Both stores live in `localStorage`, which the
   * server render cannot see, so before the effect runs "no account" and "not
   * looked yet" are the same value. Opening the first-run window on that would
   * flash it at a user who already has an account, every single visit.
   */
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<ForgeAccount | null>(null);
  const [settings, setSettings] = useState<ForgeSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Closed by hand this session, with no account created.
   *
   * The window opens itself until an account exists, and it must still be
   * possible to walk past it: the 2026-08-28 finding is that a first-run screen
   * a user cannot answer honestly gets answered dishonestly. Dismissing lasts
   * for the session and it comes back next visit, because the question is real.
   */
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);

  useEffect(() => {
    setAccount(loadAccount());
    setSettings(loadSettings());
    setReady(true);
  }, []);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const needsPackage = intent !== "spice";
  const firstRunOpen = ready && account === null && !firstRunDismissed;

  /** Every change on the first-run window is persisted, so leaving by any route keeps it. */
  const changeSettings = useCallback((next: ForgeSettings) => {
    setSettings(saveSettings(next).settings);
  }, []);

  const createAccount = useCallback((draft: AccountDraft) => {
    setAccount(saveAccount(draft, null));
  }, []);

  /**
   * IDENTIFY, WHICH IS FREE.
   *
   * Deterministic and model-free, so it runs the moment a file lands and its
   * result is what makes the intent choice informed rather than blind. It must
   * stay free: the moment this needs a model call it belongs behind the Read
   * button with everything else that costs money.
   *
   * TODO(merge): `/api/identify` does not exist yet. It is the text pass that
   * `/api/parse` already runs first internally - part number, manufacturer, page
   * count, the ordering table's designators - returned without the model leg.
   */
  const identify = useCallback(async (chosen: File) => {
    setBusy(true);
    setStatus(`Identifying ${chosen.name}…`);
    try {
      const body = new FormData();
      body.append("file", chosen);
      const response = await fetch("/api/identify", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read this file.");
      setIdentified(payload as Identified);
      setChosenPackage((payload as Identified).packages[0]?.designator ?? null);
      setPhase("identified");
      setStatus("");
    } catch (error) {
      // A file we cannot identify is not a file we refuse: the model pass may
      // still read it. The screen says so rather than dead-ending.
      setStatus(error instanceof Error ? error.message : "Could not identify this file.");
      setIdentified(null);
      setPhase("identified");
    } finally {
      setBusy(false);
    }
  }, []);

  const onPick = useCallback(
    (chosen: File | null) => {
      if (!chosen) return;
      setFile(chosen);
      void identify(chosen);
    },
    [identify]
  );

  /**
   * THE READ. Ninety seconds and one model call, begun on purpose.
   *
   * TODO(merge): this is `handleFile` / `handleLookup` from `src/app/page.tsx`,
   * with two additions the server needs to honour: `intent`, which decides the
   * field set and the pages to render, and `packageType`, which is already
   * supported and must be sent BEFORE the read rather than after - every pin
   * reader takes the package as an argument.
   */
  const runRead = useCallback(async () => {
    if (!file && !prompt.trim()) return;
    setPhase("reading");
    setBusy(true);
    setElapsedMs(0);
    const started = Date.now();
    const tick = window.setInterval(() => setElapsedMs(Date.now() - started), TICK_MS);

    try {
      let payload: Record<string, unknown>;
      if (file) {
        const body = new FormData();
        body.append("file", file);
        body.append("intent", intent);
        if (needsPackage && chosenPackage) body.append("packageType", chosenPackage);
        body.append("settings", JSON.stringify(settings));
        const response = await fetch("/api/parse", { method: "POST", body });
        payload = await response.json();
        if (!response.ok) throw new Error((payload.error as string) || "Could not read that datasheet.");
      } else {
        const response = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partNumber: prompt.trim(),
            intent,
            ...(needsPackage && chosenPackage ? { packageType: chosenPackage } : {}),
            settings
          })
        });
        payload = await response.json();
        if (!response.ok) throw new Error((payload.error as string) || "Could not find that datasheet.");
      }

      setPart(payload.part as PartRecord);
      setPackageChoice((payload.packageChoice as PackageChoice) ?? null);
      const choice = payload.packageChoice as PackageChoice | undefined;
      const option = choice?.ok
        ? choice.options.find((o) => o.designator === chosenPackage) ?? choice.options[0]
        : undefined;
      setGeometry(option?.geometry ?? null);
      setPhase("done");
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The read failed.");
      setPhase("identified");
    } finally {
      window.clearInterval(tick);
      setBusy(false);
    }
  }, [file, prompt, intent, needsPackage, chosenPackage, settings]);

  /**
   * TAKE THE BUNDLE. This button had no `onClick` at all.
   *
   * It rendered enabled, in the primary colour, at the end of the flow, and did
   * nothing when pressed: the shell was built with the export left as one of the
   * `TODO(merge)` seams and nothing on screen said so. A primary action that
   * silently refuses is the defect written up on 2026-08-28 in its purest form,
   * and here it was not even refusing, it was ignoring.
   *
   * Ported from `handleExport` in `src/app/page.tsx`, keeping the parts that
   * carry a reason. The ORDER of the spread is load-bearing and is why this is a
   * port rather than a fresh call: install-scoped answers first so a remembered
   * forming die is sent on an export nobody answered anything for this time,
   * then the settings. Reversing those two made a question unanswerable, which
   * took a browser session to find.
   */
  const takeTheBundle = useCallback(async () => {
    if (!part) return;
    setBusy(true);
    setRefusal(null);
    setStatus(`Building the ${FORMATS.find((f) => f.value === format)?.label ?? format} bundle…`);
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          part,
          format,
          // The package the user is HOLDING. This is what makes `/api/export`
          // apply `asPackage`, which is the only place the relabelling rule is.
          ...(needsPackage && chosenPackage ? { packageType: chosenPackage } : {}),
          ...answersFromSettings(settings),
          settings
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const code = payload?.code;
        // EACH REFUSAL NAMES ITS FIELDS. A value the user can supply is a
        // different thing from one the datasheet never stated, and both are
        // different from a name this format cannot encode.
        if (code === "INPUT_REQUIRED" && Array.isArray(payload?.needs) && payload.needs.length > 0) {
          setRefusal({
            kind: "needs",
            fields: (payload.needs as Array<{ field?: string; label?: string }>).map(
              (need) => need.label ?? need.field ?? "a value"
            )
          });
          setStatus("");
          return;
        }
        if (code === "UNTRACEABLE_EXTRACTION" && Array.isArray(payload?.untraceable)) {
          setRefusal({ kind: "untraceable", fields: payload.untraceable as string[] });
          setStatus("");
          return;
        }
        if (code === "INCOMPLETE_EXTRACTION" && Array.isArray(payload?.missing)) {
          setRefusal({ kind: "missing", fields: payload.missing as string[] });
          setStatus("");
          return;
        }
        if (code === "FORMAT_CANNOT_ENCODE") {
          const alternative = (payload?.availableFormats as string[] | undefined)?.[0];
          setStatus(
            alternative
              ? `${payload?.error} Try ${alternative.toUpperCase()}, which has no such limit.`
              : String(payload?.error ?? "That format cannot encode this name.")
          );
          return;
        }
        throw new Error(String(payload?.error ?? "The export failed."));
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${part.partNumber.value || "forge-part"}-forge.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      // WHAT THE SERVER SAID ABOUT WHAT IT BUILT, not our guess at it. The note
      // carries things like a package having been relabelled.
      const said = decodeURIComponent(response.headers.get("X-Forge-Export-Note") || "");
      setStatus(said || "Downloaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  }, [part, format, needsPackage, chosenPackage, settings]);

  const reset = useCallback(() => {
    setPhase("empty");
    setRefusal(null);
    setFile(null);
    setPrompt("");
    setIdentified(null);
    setPart(null);
    setPackageChoice(null);
    setGeometry(null);
    setChosenPackage(null);
    setStatus("");
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  /**
   * The stages and where the bar sits, recomputed from the clock every tick.
   *
   * DERIVED, never stored. The old version kept a `stages` array in state, wrote
   * to it nowhere and rendered stage three as active forever: the state and the
   * screen could not disagree, because the screen was not reading the state. A
   * value computed from `elapsedMs` cannot go stale that way.
   */
  const stages = useMemo(() => stagesFor(intent), [intent]);
  const progress = useMemo(
    () => progressAt(elapsedMs, stages, phase === "done"),
    [elapsedMs, stages, phase]
  );
  const seconds = Math.round(elapsedMs / 1000);

  /**
   * WHAT IS BEING WORKED ON, IN THE ONE LINE THAT PERSISTS.
   *
   * This carries the identification as well as the name, so the free pass has
   * somewhere to report without a five-row table under it saying the same
   * things again. The part number leads because it is what an engineer is
   * holding; the file name is the fallback when nothing could be identified.
   */
  const composer = useMemo(() => {
    const name = identified?.partNumber || file?.name || prompt.trim();
    const facts = identified
      ? [identified.manufacturer, `${identified.pageCount} pages`].filter(Boolean).join(" · ")
      : "";
    if (phase === "reading") return { text: name, sub: [facts, `reading ${clock(seconds)}`].filter(Boolean).join(" · ") };
    if (phase === "done") return { text: name, sub: [facts, `read in ${clock(seconds)}`].filter(Boolean).join(" · ") };
    return { text: name, sub: facts };
  }, [phase, identified, file, prompt, seconds]);

  const showCad = intent !== "spice";
  const showSpice = intent !== "cad";

  return (
    <div className={`suite suite-${phase}`}>
      <header className="suite-bar">
        {/* The one wordmark. It carried the heat rule twice: here, and again as
            an eyebrow over the hero heading two inches below. */}
        <span className="wordmark">
          Forge<i className="suite-heat" aria-hidden="true" />
        </span>
        {/* WHO IS SIGNED IN, BESIDE THE GEAR THAT CHANGES IT. A settings icon
            with nothing next to it makes the user open the panel to find out
            whether the first run ever completed. */}
        {ready && account && <span className="suite-who">{account.organisation ?? account.name}</span>}
        <button
          type="button"
          className="gear"
          onClick={() => setSettingsOpen(true)}
          aria-label="Account and assembly line settings"
          title="Account and assembly line settings"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.4H9l-.3 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.3 2.6h6l.3-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      {/* THE FIRST RUN OPENS ITSELF, and only until an account exists. It is
          rendered after `ready` so a returning user never sees it flash: before
          the mount effect, "no account" and "not looked yet" are the same value. */}
      {firstRunOpen && (
        <Onboarding
          settings={settings}
          onSaveSettings={changeSettings}
          onCreateAccount={createAccount}
          onDismiss={() => setFirstRunDismissed(true)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          account={account}
          settings={settings}
          onAccount={setAccount}
          onSettings={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <main className="suite-main">
        {phase === "empty" && (
          <div className="suite-hero">
            <h1>Drop a datasheet, or name a part.</h1>
          </div>
        )}

        {/* THE FRAME. One element for the whole session: it settles to the top
            after the first submit and everything below is its body. */}
        <section className="frame">
          <span className={`frame-top frame-top-${phase}`} aria-hidden="true" />

          <div className="frame-composer">
            {phase === "empty" ? (
              <input
                className="frame-input"
                value={prompt}
                // The heading above says where a PDF goes. The placeholder used
                // to repeat it word for word, one line apart.
                placeholder="LMP7704-SP"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && prompt.trim()) void runRead();
                }}
              />
            ) : (
              <span className="frame-held">
                <span className="frame-name">{composer.text}</span>
                <span className="frame-sub">{composer.sub}</span>
              </span>
            )}
            {phase !== "empty" && (
              <button type="button" className="btn btn-quiet" onClick={reset} disabled={busy}>
                Start another part
              </button>
            )}
          </div>

          <div className="frame-intents">
            {INTENTS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`chip${intent === option.key ? " chip-on" : ""}`}
                // Locked once the read has been spent: it is what aimed the read,
                // so changing it here would describe a read that did not happen.
                disabled={phase === "reading" || phase === "done"}
                // The stages follow the intent by derivation, not by a second
                // setter kept in step by hand.
                onClick={() => setIntent(option.key)}
              >
                {option.label}
              </button>
            ))}
            <span className="frame-actions">
              {phase !== "empty" && <span className="frame-status">{status}</span>}
              {phase === "empty" && (
                <>
                  <input
                    ref={fileInput}
                    id="suite-file"
                    type="file"
                    accept="application/pdf"
                    className="visually-hidden"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0] ?? null;
                      event.target.value = "";
                      onPick(chosen);
                    }}
                  />
                  <label className="btn" htmlFor="suite-file">
                    Choose a PDF
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !prompt.trim()}
                    onClick={() => void runRead()}
                  >
                    {intent === "cad" ? "Read for CAD" : intent === "spice" ? "Read for SPICE" : "Read for both"}
                  </button>
                </>
              )}
            </span>
          </div>

          {phase === "identified" && (
            <div className="frame-body">
              {/* THE IDENTIFICATION IS IN THE COMPOSER LINE, not in a table
                  under it. Part, manufacturer and page count were printed twice
                  on this screen, two inches apart, and the two remaining rows
                  were a count of the list directly below and eight characters
                  of a hash nothing on the screen used. */}
              {needsPackage ? (
                <div className="pick-package">
                  <h2 className="frame-label">Package</h2>
                  <ul className="packages">
                    {(identified?.packages ?? []).map((variant) => (
                      <li key={variant.designator}>
                        <button
                          type="button"
                          className={`pkg${chosenPackage === variant.designator ? " pkg-active" : ""}`}
                          onClick={() => setChosenPackage(variant.designator)}
                        >
                          <span className="pkg-name">{variant.designator}</span>
                          <span className="pkg-meta">
                            {variant.family}
                            {variant.leadCount ? ` · ${variant.leadCount} leads` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                // Said once, because the absence of a chooser is otherwise
                // unexplained. The rest of the reasoning is in this file's
                // header comment.
                <p className="frame-note">No package to choose: a macromodel describes the die.</p>
              )}

              <div className="frame-go">
                <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void runRead()}>
                  {needsPackage && chosenPackage ? `Read for ${chosenPackage}` : "Read for the model"}
                </button>
                <span className="frame-note">{intentNote(intent)}</span>
              </div>
            </div>
          )}

          {phase === "reading" && (
            <div className="frame-body">
              {/* THE FILL IS DRIVEN, NOT DECORATIVE. Width comes from the clock
                  and a linear transition of one tick carries it between samples,
                  so it always reads as moving. It stops short of full and creeps:
                  only the response landing fills it. */}
              <div
                className="heat"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={4}
                aria-valuenow={progress.index + 1}
                aria-valuetext={`Stage ${progress.index + 1} of 4, ${stages[progress.index]?.name ?? ""}`}
              >
                <span className="heat-fill" style={{ width: `${(progress.fraction * 100).toFixed(2)}%` }}>
                  <span className="heat-sweep" />
                </span>
              </div>
              {/* FOUR NAMES AND FOUR CLOCKS. Each row also carried a sentence
                  explaining itself, so a screen whose whole job is "wait" held
                  four stage names, four timestamps, four explanations and a
                  four-line paragraph. The explanations are on the rows as
                  `title`, where they are there for whoever wants them and are
                  not read by everybody every run. */}
              <ol className="stages">
                {stages.map((stage, index) => {
                  const state = index < progress.index ? "stage-done" : index === progress.index ? "stage-on" : "stage-todo";
                  const startedAt = progress.startedAt[index];
                  return (
                    <li key={stage.name} className={`stage ${state}`} title={stage.note}>
                      <span className="stage-dot" aria-hidden="true" />
                      <span className="stage-name">{stage.name}</span>
                      <span className="stage-at">{startedAt === null ? "" : clock(startedAt)}</span>
                    </li>
                  );
                })}
              </ol>
              {/* NO PARAGRAPH UNDER THE BAR. Anthony's call, 2026-09-02: it
                  said the read takes about ninety seconds and that the bar is an
                  estimate, and neither is worth a line of prose on every run.
                  The elapsed clock is in the composer at the top of the frame,
                  which is the one place this screen keeps one. */}
            </div>
          )}

          {phase === "done" && part && (
            <div className="frame-body frame-done">
              {/* TODO(merge): the verdict card, the review list, the confirm loop
                  and the export refusal panel all live in `src/app/page.tsx` and
                  drop in here unchanged. Only the shell around them is new. */}
              {/* NOT OFFERED WHEN IT CANNOT SUCCEED. `packageChoice.ok === false`
                  means the reading is short of something no choice on this screen
                  can supply, so the button below could only produce a refusal.
                  Same rule the existing workspace applies to `Build library`.

                  Said ONCE, beside the disabled button further down. It used to
                  be said here as well, in different words, on the same screen. */}
              <div className="outputs">
                {showCad && (
                  <div className="output">
                    <h3>Footprint</h3>
                    {geometry ? (
                      <FootprintPreview geometry={geometry} source={geometry.provenance.source} />
                    ) : (
                      <p className="frame-note">No geometry was produced for {chosenPackage ?? "this package"}.</p>
                    )}
                  </div>
                )}
                {showSpice && (
                  <div className="output">
                    <h3>SPICE model</h3>
                    {/* TODO(merge): `/api/model` and a `SpiceModel` type. The
                        netlist is deterministic templating over the extracted
                        parameters, exactly as the footprint emitters are: no
                        model writes it. */}
                    <p className="frame-note">Netlist panel goes here.</p>
                  </div>
                )}
              </div>
              {/* WHICH CAD TOOL. This was missing entirely, so the button that
                  did nothing would not have known what to build even if it had
                  fired. Cadence is offered and disabled rather than hidden: a
                  format with no generator is a fact about the product, and
                  hiding it invites the assumption that it is coming. */}
              {showCad && (
                <fieldset className="fmt-set">
                  <legend className="fmt-legend">Bundle format</legend>
                  <div className="fmt-row">
                    {FORMATS.map((option) => (
                      <label
                        key={option.value}
                        className={`fmt${format === option.value ? " fmt-on" : ""}${option.ready ? "" : " fmt-off"}`}
                      >
                        <input
                          type="radio"
                          name="suite-format"
                          value={option.value}
                          checked={format === option.value}
                          disabled={!option.ready || busy}
                          onChange={() => {
                            setFormat(option.value);
                            setRefusal(null);
                            setStatus("");
                          }}
                        />
                        <span className="fmt-name">{option.label}</span>
                        <span className="fmt-note">{option.note}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {/* THE REFUSAL, WITH ITS FIELDS. `/api/export` answers which values
                  it could not stand behind, and the whole argument of the product
                  is that it says so. Collapsing that to "Export failed" throws
                  away the only part the user can act on. */}
              {refusal && (
                <div className="refusal" role="alert">
                  {/* THE HEAD NAMES THE KIND, THE LIST NAMES THE FIELDS. Each
                      kind then carried a second paragraph underneath. Only one
                      of the three told the user what to do next; the other two
                      argued that the refusal was correct, which is not
                      something a person blocked on an export needs to read. */}
                  <p className="refusal-head">
                    {refusal.kind === "needs"
                      ? "Your line has to answer this, in Settings."
                      : refusal.kind === "untraceable"
                        ? "These could not be traced to a page of the datasheet."
                        : "The datasheet does not state these."}
                  </p>
                  <ul className="refusal-fields">
                    {refusal.fields.map((field) => (
                      <li key={field}>{field}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="frame-go">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={busy || (packageChoice ? !packageChoice.ok : false)}
                  onClick={() => void takeTheBundle()}
                >
                  {busy
                    ? "Building…"
                    : intent === "spice"
                      ? "Take the model"
                      : intent === "cad"
                        ? "Take the library"
                        : "Take both bundles"}
                </button>
                {/* Beside the button, not only above it: a greyed primary action
                    with no reason next to it reads as a broken screen. */}
                {packageChoice && !packageChoice.ok && (
                  <span className="frame-note">
                    This reading is missing {packageChoice.blockedBy.join(" and ")}.
                  </span>
                )}
                {status && <span className="frame-status">{status}</span>}
              </div>
            </div>
          )}
        </section>

        {phase === "empty" && <p className="frame-note frame-note-centred">{intentNote(intent)}</p>}
      </main>
    </div>
  );
}
