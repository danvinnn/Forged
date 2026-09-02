"use client";

/**
 * THE ASSEMBLY LINE'S FOUR SETTINGS, IN ONE PLACE.
 *
 * Rendered by the first run and by the gear panel, because they must not drift:
 * a user who set the density in one and read it in the other would be looking at
 * two screens that could disagree about their own line.
 *
 * ## Presets are named settings, not a personality quiz
 *
 * Each preset writes real values into the same four rows below, and the rows say
 * what it wrote. A preset is a shortcut through the table, not a fifth thing to
 * configure.
 *
 * ## Blank is an answer, and which kind depends on the row
 *
 * Where a published standard answers a field, blank means that standard and the
 * row NAMES it, so nobody accepts something unnamed (RULES.md 3). Where no
 * standard answers it, blank means unanswered, and the product asks for the
 * number by name later, when a part actually cannot be built without it. It is
 * never invented here and never required here: requiring it is what made an
 * engineer fabricate two numbers on 2026-08-28.
 *
 * The named standard is printed WHILE THE ROW IS BLANK, which is the whole
 * window in which it decides anything. It used to print under every row at all
 * times, so a user who had chosen density C read a sentence about what leaving
 * it blank would have meant. Four rows of that is most of the text on the
 * screen, and none of it was about the state the screen was in.
 *
 * ## An out-of-range number says so where it was typed
 *
 * `parseSettings` drops anything above what `/api/export` accepts, which is
 * right, and used to do it in silence: the box still showed 8, the screen still
 * said the field was needed, and nothing joined the two. The limit is carried on
 * the field for exactly this, so the row states it.
 */

import { useState } from "react";
import { SETTINGS_FIELDS, type ForgeSettings, type FootprintSource } from "../../lib/settings";
import type { DensityLevel } from "../../lib/ipc7351";

type PresetKey = "hobby" | "prod" | "flight";

/**
 * PROPOSALS, NOT DECISIONS. Every value here is a level of a published standard
 * or a documented practice; nothing in a preset is a number one shop made up.
 */
const PRESETS: Array<{ key: PresetKey; name: string; note: string; settings: ForgeSettings }> = [
  // The note is what the preset WRITES, in the fewest words that still
  // distinguish it from the other two. Each was a pair of sentences, three
  // cards wide, above the four rows that state the same values exactly.
  {
    key: "hobby",
    name: "Hobbyist / bench",
    note: "Most copper. Hand rework.",
    settings: { densityLevel: "A", footprintSource: "datasheet-first" }
  },
  {
    key: "prod",
    name: "Production",
    note: "Nominal copper. Contract assembly.",
    settings: { densityLevel: "B", footprintSource: "datasheet-first" }
  },
  {
    key: "flight",
    name: "Rad-hard / flight",
    note: "Least copper. Every joint computed.",
    settings: { densityLevel: "C", footprintSource: "standard-always" }
  }
];

const DENSITY_CHOICES: Array<{ value: DensityLevel; label: string }> = [
  { value: "A", label: "A, most copper, for hand rework" },
  { value: "B", label: "B, the standard's own nominal" },
  { value: "C", label: "C, least copper, for dense assemblies" }
];

const SOURCE_CHOICES: Array<{ value: FootprintSource; label: string }> = [
  { value: "datasheet-first", label: "The manufacturer's pattern where one is printed" },
  { value: "standard-always", label: "Always compute from IPC-7351B" }
];

/** Which preset these settings are, if they are one. A hand-edited value is none. */
function presetOf(settings: ForgeSettings): PresetKey | null {
  const match = PRESETS.find(
    (option) =>
      option.settings.densityLevel === settings.densityLevel &&
      option.settings.footprintSource === settings.footprintSource
  );
  return match?.key ?? null;
}

function text(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export default function AssemblyForm({
  value,
  onChange
}: {
  value: ForgeSettings;
  onChange: (next: ForgeSettings) => void;
}) {
  // The two numbers are held as TYPED TEXT, not as numbers. A number state
  // cannot represent "0." mid-edit, and clearing the box has to mean
  // "unanswered" rather than snapping back to the last value that parsed.
  const [span, setSpan] = useState(() => text(value.formedLeadSpanMm));
  const [contact, setContact] = useState(() => text(value.formedLeadContactMm));
  const active = presetOf(value);

  function applyPreset(key: PresetKey) {
    const preset = PRESETS.find((option) => option.key === key);
    if (!preset) return;
    // A preset never touches the forming die. Nothing published can answer it,
    // so a preset that filled it in would be inventing on the user's behalf.
    onChange({ ...value, ...preset.settings });
  }

  function setNumber(key: "formedLeadSpanMm" | "formedLeadContactMm", raw: string) {
    const next = { ...value };
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) delete next[key];
    else next[key] = parsed;
    onChange(next);
  }

  /** Whether what is in the box is something the export route would refuse. */
  function overLimit(raw: string, max: number | undefined): boolean {
    if (max === undefined || raw.trim() === "") return false;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && (parsed <= 0 || parsed > max);
  }

  return (
    <div className="assembly">
      <ul className="onboard-presets">
        {PRESETS.map((option) => (
          <li key={option.key}>
            <button
              type="button"
              className={`preset${active === option.key ? " preset-on" : ""}`}
              aria-pressed={active === option.key}
              onClick={() => applyPreset(option.key)}
            >
              <span className="preset-name">{option.name}</span>
              <span className="preset-note">{option.note}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* LABEL, CONTROL, THEN THE REASON UNDER IT.
          This was a three-column table: label, control, and a paragraph of prose
          squeezed into whatever was left. At 760px the reason column wrapped to
          four ragged lines per row and the whole window grew past the bottom of
          the screen. The same information reads in half the height when the
          explanation sits under its own control at full width. */}
      <div className="fields">
        {SETTINGS_FIELDS.map((field) => {
          if (field.key === "densityLevel" || field.key === "footprintSource") {
            const isDensity = field.key === "densityLevel";
            const id = isDensity ? "set-density" : "set-source";
            const choices = isDensity ? DENSITY_CHOICES : SOURCE_CHOICES;
            const current = (isDensity ? value.densityLevel : value.footprintSource) ?? "";
            // Only while blank: see the note at the top of this file.
            const standardHint =
              current === "" && field.standard !== null ? `Blank means ${field.standard}.` : null;
            return (
              <div className="field" key={field.key}>
                <label className="field-label" htmlFor={id}>
                  {field.label}
                </label>
                <select
                  id={id}
                  className="set-input"
                  value={current}
                  onChange={(event) => {
                    const next = { ...value };
                    const chosen = event.target.value;
                    if (chosen === "") {
                      if (isDensity) delete next.densityLevel;
                      else delete next.footprintSource;
                    } else if (isDensity) {
                      next.densityLevel = chosen as DensityLevel;
                    } else {
                      next.footprintSource = chosen as FootprintSource;
                    }
                    onChange(next);
                  }}
                >
                  <option value="">Leave blank</option>
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {field.why} {standardHint && <span className="field-standard">{standardHint}</span>}
                </p>
              </div>
            );
          }

          const isSpan = field.key === "formedLeadSpanMm";
          const raw = isSpan ? span : contact;
          const bad = overLimit(raw, field.max);
          return (
            <div className="field" key={field.key}>
              <label className="field-label" htmlFor={`set-${field.key}`}>
                {field.label}
              </label>
              <span className="set-number">
                <input
                  id={`set-${field.key}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max={field.max}
                  placeholder="blank"
                  aria-invalid={bad}
                  value={raw}
                  onChange={(event) => {
                    const typed = event.target.value;
                    if (isSpan) setSpan(typed);
                    else setContact(typed);
                    setNumber(field.key as "formedLeadSpanMm" | "formedLeadContactMm", typed);
                  }}
                />
                <span className="set-unit">{field.unit}</span>
              </span>
              {/* The "blank stays blank until a part needs it" sentence that
                  used to sit here is now said once, under the form, for both
                  of these rows at the same time. */}
              <p className="field-hint">{field.why}</p>
              {bad && (
                <p className="set-bad">Above 0 and no more than {field.max} mm, which is what the export accepts.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
