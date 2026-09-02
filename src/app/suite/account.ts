/**
 * WHO IS USING THIS INSTALLATION, AND WHAT THEIR LINE DOES.
 *
 * ## Why an account exists at all, and why it is local
 *
 * RULES.md 3 says the settings that genuinely differ between users are settled
 * once, up front, rather than interrupting a run. "Once" needs somewhere to
 * write "this person has been asked". That is all an account is here: a record
 * that the first run happened, carrying the name to put on a library and the
 * timestamp the settings were accepted at.
 *
 * IT DOES NOT LEAVE THE BROWSER. There is no server behind it, no request, no
 * third party. The standing constraint is that controlled datasheets never
 * leave the customer environment and that this is enforced structurally rather
 * than by a runtime check: an account that posts a name somewhere is the first
 * crack in that, so this one cannot, because there is nothing to post to.
 *
 * ## Signing in is not a gate, and must never become one
 *
 * Until 2026-08-28 the two forming-die numbers blocked every datasheet. An
 * engineer hit them on a plastic SOT-23, could not answer either honestly, and
 * invented two numbers to get past it: the exact failure RULES.md 1 exists to
 * prevent, caused by the screen that exists to enforce it.
 *
 * So the first run OPENS ITSELF and closes in one click. What it changes is the
 * TIMING of the settings question, which is what RULES.md 3 asks for. It does
 * not change what happens to someone who has nothing to say: the two fields no
 * standard answers stay blank, and a part that cannot be built without them is
 * still refused BY NAME later, with the drawing beside the question.
 */

import {
  parseSettings,
  outOfRange,
  type ForgeSettings,
  type SettingsField
} from "../../lib/settings";

/**
 * The record that says the first run happened.
 *
 * Only `name` is required, and only because a library has to be signed by
 * somebody. Nothing here is validated against anything: an email nobody sends
 * to is a label, not a credential, and pretending otherwise would be a login
 * screen that cannot refuse anyone.
 */
export interface ForgeAccount {
  name: string;
  organisation: string | null;
  email: string | null;
  /** ISO 8601. The moment the settings below were accepted, not a session. */
  createdAt: string;
}

const ACCOUNT_KEY = "forge.account";

/**
 * The same two stores `src/app/page.tsx` reads.
 *
 * READ TOGETHER, deliberately. The forming-die numbers are written by the
 * settings screen under `forge.settings` and by the mid-parse question under
 * `forge.install.*`, and they are the same two numbers. A user who answered one
 * way must not be asked again the other way.
 */
const SETTINGS_KEY = "forge.settings";
const INSTALL_KEY_PREFIX = "forge.install.";
const INSTALL_FIELDS = ["formedLeadSpanMm", "formedLeadContactMm"] as const;

/** Whether the browser will let us keep anything at all. */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // A blocked store costs one re-entry per visit, not a read. Nothing here
    // gates anything, so failing quiet is the honest outcome.
    return null;
  }
}

/**
 * The account, or null if the first run has not happened.
 *
 * A stored record missing a name is treated as absent rather than repaired. A
 * half-written account would otherwise silently suppress the first run, which
 * is the one thing this value decides.
 */
export function loadAccount(): ForgeAccount | null {
  const held = store();
  if (!held) return null;
  try {
    const raw = held.getItem(ACCOUNT_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (name === "") return null;
    return {
      name,
      organisation: typeof parsed.organisation === "string" && parsed.organisation.trim() !== "" ? parsed.organisation.trim() : null,
      email: typeof parsed.email === "string" && parsed.email.trim() !== "" ? parsed.email.trim() : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

/** Write the account. Returns what was actually stored, trimmed. */
export function saveAccount(input: { name: string; organisation: string; email: string }, existing: ForgeAccount | null): ForgeAccount {
  const account: ForgeAccount = {
    name: input.name.trim(),
    organisation: input.organisation.trim() === "" ? null : input.organisation.trim(),
    email: input.email.trim() === "" ? null : input.email.trim(),
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  const held = store();
  if (held) {
    try {
      held.setItem(ACCOUNT_KEY, JSON.stringify(account));
    } catch {
      // Unsaved still applies to this session; the first run returns next visit.
    }
  }
  return account;
}

/**
 * Forget the account. The settings are NOT touched.
 *
 * Signing out means "ask me the first-run questions again", not "throw away the
 * numbers my line runs on". Those belong to the installation and outlast whoever
 * typed them; clearing them here would silently un-answer the forming die and
 * put the two per-part questions back on a user who had settled them.
 */
export function clearAccount(): void {
  const held = store();
  if (!held) return;
  try {
    held.removeItem(ACCOUNT_KEY);
  } catch {
    // Nothing to do: the account is already unreadable to us either way.
  }
}

/** The installation's settings, from both stores, bounded exactly as the export route bounds them. */
export function loadSettings(): ForgeSettings {
  const held = store();
  if (!held) return {};
  try {
    const restored: Record<string, number> = {};
    for (const field of INSTALL_FIELDS) {
      const saved = held.getItem(`${INSTALL_KEY_PREFIX}${field}`);
      const parsed = saved === null ? NaN : Number(saved);
      if (Number.isFinite(parsed) && parsed > 0) restored[field] = parsed;
    }
    const stored = held.getItem(SETTINGS_KEY);
    return parseSettings({ ...restored, ...(stored ? (JSON.parse(stored) as Record<string, unknown>) : {}) });
  } catch {
    return {};
  }
}

/**
 * Persist, and say what was thrown away.
 *
 * `parseSettings` drops an out-of-range number, which is right, and used to do
 * it in silence: the box still showed the value the user typed and nothing on
 * screen connected the two. The rejected fields come back so the screen can
 * name the field and its limit.
 */
export function saveSettings(next: ForgeSettings): { settings: ForgeSettings; rejected: SettingsField[] } {
  const clean = parseSettings(next);
  const rejected = outOfRange(next as Record<string, unknown>);
  const held = store();
  if (held) {
    try {
      held.setItem(SETTINGS_KEY, JSON.stringify(clean));
      // Kept in step with the per-question store so neither goes stale.
      for (const field of INSTALL_FIELDS) {
        const value = clean[field];
        if (typeof value === "number") held.setItem(`${INSTALL_KEY_PREFIX}${field}`, String(value));
        else held.removeItem(`${INSTALL_KEY_PREFIX}${field}`);
      }
    } catch {
      // Unsaved settings still apply to this session.
    }
  }
  return { settings: clean, rejected };
}
