"use client";

/**
 * THE GEAR, WHICH IS THE WAY BACK IN AFTER THE FIRST RUN.
 *
 * Two tabs over the same two records the first run wrote: the account, and the
 * assembly line. It renders `AccountForm` and `AssemblyForm` rather than its own
 * copies, so there is exactly one description of each field in the product and
 * the two screens cannot drift about what a user's line does.
 *
 * ## Signing out forgets the account and keeps the settings
 *
 * Deliberately. "Sign out" means "ask me the first-run questions again", not
 * "throw away the numbers my line runs on": the forming die belongs to the
 * installation and outlasts whoever typed it. Clearing it here would silently
 * un-answer two fields and put seven parts' worth of per-part questions back in
 * front of a user who had settled them once, which is the whole failure
 * `settings.ts` was written against.
 *
 * ## Save says what it refused
 *
 * `parseSettings` drops a number `/api/export` would not accept. Doing that
 * silently leaves the box showing the value and nothing on screen explaining
 * where it went, so the rejected fields come back from `saveSettings` and are
 * printed here by name and limit.
 */

import { useState } from "react";
import AssemblyForm from "./AssemblyForm";
import AccountForm, { type AccountDraft } from "./AccountForm";
import { clearAccount, saveAccount, saveSettings, type ForgeAccount } from "./account";
import type { ForgeSettings } from "../../lib/settings";

type Tab = "account" | "line";

export default function SettingsPanel({
  account,
  settings,
  onAccount,
  onSettings,
  onClose
}: {
  account: ForgeAccount | null;
  settings: ForgeSettings;
  onAccount: (next: ForgeAccount | null) => void;
  onSettings: (next: ForgeSettings) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("account");
  const [draft, setDraft] = useState<AccountDraft>(() => ({
    name: account?.name ?? "",
    organisation: account?.organisation ?? "",
    email: account?.email ?? ""
  }));
  // What was typed but not stored, and the working copy of the line's settings.
  // Held here rather than pushed straight through, so Save is a decision and
  // closing the panel without it changes nothing.
  const [working, setWorking] = useState<ForgeSettings>(settings);
  const [said, setSaid] = useState("");

  function saveLine() {
    const result = saveSettings(working);
    onSettings(result.settings);
    setSaid(
      result.rejected.length === 0
        ? "Saved."
        : result.rejected.map((field) => `${field.label} must be above 0 and no more than ${field.max} mm, so it was not kept.`).join(" ")
    );
  }

  function saveAcct() {
    if (draft.name.trim() === "") return;
    onAccount(saveAccount(draft, account));
    setSaid("Saved.");
  }

  return (
    <div className="onboard-scrim" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="onboard">
        <header className="onboard-head">
          <div className="onboard-heading">
            <h1 id="settings-title">Settings</h1>
            {/* ONE LINE PER TAB. Each tab had this sub AND a lead paragraph
                below the tab strip, and the two said the same thing twice with
                about twenty words between them. */}
            <p className="onboard-sub">
              {tab === "account" ? "Who the libraries are signed by. Stored on this machine." : "What your line does."}
            </p>
          </div>
          <button type="button" className="onboard-close" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="onboard-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "account"}
            className={`onboard-tab${tab === "account" ? " on" : ""}`}
            onClick={() => {
              setTab("account");
              setSaid("");
            }}
          >
            Account
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "line"}
            className={`onboard-tab${tab === "line" ? " on" : ""}`}
            onClick={() => {
              setTab("line");
              setSaid("");
            }}
          >
            Assembly line
          </button>
        </div>

        <div className="onboard-body">
          {tab === "account" ? (
            <>
              {/* Only when there is something to say that the fields do not.
                  A created account said its date and then repeated the privacy
                  line from the header. */}
              {!account && <p className="onboard-lead">No account yet. Creating one stops the first-run window.</p>}
              <AccountForm value={draft} onChange={setDraft} idPrefix="settings" />
            </>
          ) : (
            <>
              <AssemblyForm value={working} onChange={setWorking} />
              {/* Said once, for both rows, and only where it applies. It was a
                  paragraph above the form describing all four rows at once,
                  plus the same sentence again under each of the last two. */}
              <p className="onboard-lead">Blank on the last two rows is unanswered. A part that needs them asks by name.</p>
            </>
          )}
        </div>

        <footer className="onboard-actions">
          {tab === "account" && account ? (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                clearAccount();
                onAccount(null);
                setDraft({ name: "", organisation: "", email: "" });
                setSaid("Signed out. Your assembly line settings were kept.");
              }}
            >
              Sign out
            </button>
          ) : (
            <span />
          )}
          <span className="onboard-actions-end">
            {said && <span className="frame-status">{said}</span>}
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            {tab === "account" ? (
              <button type="button" className="btn btn-primary" disabled={draft.name.trim() === ""} onClick={saveAcct}>
                {account ? "Save account" : "Create account"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={saveLine}>
                Save settings
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
