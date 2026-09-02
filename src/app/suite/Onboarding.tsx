"use client";

/**
 * FIRST RUN: THE ASSEMBLY LINE, THEN THE ACCOUNT. IT OPENS ITSELF.
 *
 * ## Why it comes before the first datasheet
 *
 * RULES.md 3: the settings that genuinely differ between one user's process and
 * another's are settled ONCE, up front, rather than interrupting a run. Asking
 * mid-parse is measurably worse: on 2026-08-19 seven parts on the tuned corpus
 * were blocked on the two forming-die numbers alone, which are the same two
 * numbers for every part that customer will ever build.
 *
 * It shows until an account exists, because the account is the record that says
 * this happened. After that the gear in the top right is the way back in.
 *
 * ## Why it still cannot gate a read, and this is the load-bearing part
 *
 * Until 2026-08-28 the two forming-die numbers BLOCKED every datasheet. An
 * engineer trying the product on a plastic SOT-23 op-amp hit two questions about
 * a ceramic flat pack's forming die, could not answer either honestly, and
 * invented two numbers to get past it:
 *
 *   "The tool made me fabricate manufacturing data to process a part the data
 *    does not apply to."
 *
 * That is the exact invention RULES.md 1 forbids, caused by the screen that
 * exists to enforce it. Measured the same day with both fields blank, all five
 * OPA333 packages still ship and RHF310A comes back `needs-input` naming those
 * two fields precisely: the product already asks when a part needs them.
 *
 * So what changed here is the TIMING, which is what rule 3 asks for, and not the
 * refusal. Every button on this window leaves it, the escape is one click, and
 * blank stays a real answer on both rows where nothing published can fill it in.
 */

import { useState } from "react";
import AssemblyForm from "./AssemblyForm";
import AccountForm, { type AccountDraft } from "./AccountForm";
import type { ForgeSettings } from "../../lib/settings";

type Step = "line" | "account";

const EMPTY: AccountDraft = { name: "", organisation: "", email: "" };

export default function Onboarding({
  settings,
  onSaveSettings,
  onCreateAccount,
  onDismiss
}: {
  settings: ForgeSettings;
  /** Called on every change, so leaving by any route keeps what was chosen. */
  onSaveSettings: (next: ForgeSettings) => void;
  onCreateAccount: (draft: AccountDraft) => void;
  onDismiss: () => void;
}) {
  const [step, setStep] = useState<Step>("line");
  const [draft, setDraft] = useState<AccountDraft>(EMPTY);
  const named = draft.name.trim() !== "";

  return (
    <div className="onboard-scrim" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
      <div className={`onboard onboard-${step}`}>
        {/* HEADER, BODY, FOOTER, and the footer does not scroll.
            The first version was a fake application window: three grey traffic
            lights and a title bar, over a body that was simply as tall as its
            content. On a 900px screen that put the primary button below the
            bottom edge of a window with no visible scrollbar, on the one screen
            a new user cannot get past. Chrome that imitates an OS is decoration;
            a footer that is always reachable is not. */}
        <header className="onboard-head">
          <div className="onboard-heading">
            <h1 id="onboard-title">{step === "line" ? "How does your line build boards?" : "Who is building them?"}</h1>
            {/* THE SUB SAYS WHAT THE HEADING DOES NOT. Both of these restated
                the heading first and then explained the mechanism of the
                window itself, which is a thing the window does not need to
                account for to the person using it. */}
            <p className="onboard-sub">
              {step === "line"
                ? "Asked once. Blank is a real answer on every row."
                : "Stored on this machine. Nothing is sent anywhere."}
            </p>
          </div>
          <ol className="onboard-steps" aria-label="First run">
            <li className={step === "line" ? "on" : "done"}>
              <span className="onboard-step-n">1</span> Assembly line
            </li>
            <li className={step === "account" ? "on" : ""}>
              <span className="onboard-step-n">2</span> Account
            </li>
          </ol>
        </header>

        <div className="onboard-body">
          {step === "line" ? (
            <>
              <AssemblyForm value={settings} onChange={onSaveSettings} />
              {/* THE 2026-08-28 FINDING, IN ONE LINE. A user who cannot answer
                  a required question invents an answer, so this window has to
                  say it does not block anything. What it does not have to do is
                  describe the later screen in advance. */}
              <p className="onboard-lead">Nothing here blocks a read. A part that needs these asks by name.</p>
            </>
          ) : (
            // The privacy fact is the subtitle now, above the fields rather
            // than in a tinted panel below them. It was in three places on this
            // step: the subtitle, the email field's own label, and the panel.
            <AccountForm value={draft} onChange={setDraft} idPrefix="onboard" />
          )}
        </div>

        <footer className="onboard-actions">
          <button type="button" className="ghost" onClick={onDismiss}>
            Skip for now
          </button>
          <span className="onboard-actions-end">
            {step === "account" && (
              <button type="button" className="btn" onClick={() => setStep("line")}>
                Back
              </button>
            )}
            {step === "line" ? (
              <button type="button" className="btn btn-primary" onClick={() => setStep("account")}>
                Save and continue
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!named}
                title={named ? undefined : "A name is the one field a library file actually carries."}
                onClick={() => onCreateAccount(draft)}
              >
                Create account and start
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
