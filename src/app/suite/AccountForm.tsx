"use client";

/**
 * THE THREE FIELDS AN ACCOUNT IS, SHARED BY THE FIRST RUN AND THE GEAR PANEL.
 *
 * ## What this is not
 *
 * It is not a login. There is no server behind it and no request leaves the
 * browser: the standing constraint is that controlled datasheets never leave
 * the customer environment, enforced structurally rather than by a check, and
 * an account that posts a name somewhere is the first crack in that. So the
 * screen says what it does rather than implying a service that is not there.
 *
 * ## Only the name is required, and only because a library gets signed
 *
 * An emitted library carries an author. That is the whole reason a name is
 * asked for, and it is the only field a downstream file uses, so it is the only
 * one that can be required without asking for something nothing consumes.
 */

export interface AccountDraft {
  name: string;
  organisation: string;
  email: string;
}

export default function AccountForm({
  value,
  onChange,
  idPrefix
}: {
  value: AccountDraft;
  onChange: (next: AccountDraft) => void;
  /** Distinct per mount: the first run and the gear panel can both be in the DOM. */
  idPrefix: string;
}) {
  return (
    <div className="acct-fields">
      <label className="acct-field" htmlFor={`${idPrefix}-name`}>
        <span className="acct-label">
          Name <em>signs every library</em>
        </span>
        <input
          id={`${idPrefix}-name`}
          type="text"
          autoComplete="name"
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>

      <label className="acct-field" htmlFor={`${idPrefix}-org`}>
        <span className="acct-label">
          Organisation <em>optional</em>
        </span>
        <input
          id={`${idPrefix}-org`}
          type="text"
          autoComplete="organization"
          value={value.organisation}
          onChange={(event) => onChange({ ...value, organisation: event.target.value })}
        />
      </label>

      <label className="acct-field" htmlFor={`${idPrefix}-email`}>
        <span className="acct-label">
          {/* "never sent anywhere" was on this field and in the panel below it. */}
          Email <em>optional</em>
        </span>
        <input
          id={`${idPrefix}-email`}
          type="email"
          autoComplete="email"
          value={value.email}
          onChange={(event) => onChange({ ...value, email: event.target.value })}
        />
      </label>
    </div>
  );
}
