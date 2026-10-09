import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  accountStatusLabel,
  assertManagementActionLive,
  contactLabel,
  isAccessError,
  managementErrorMessage,
  QUALIFICATION_TYPES,
  refreshedAddress,
} from "../lib/staffManagement.js";
import ContactChange from "./ContactChange.jsx";
import { savedPhone } from "../../shared/contact-input.js";

export function ProfileDetails({ account, profile }) {
  const phone = savedPhone(profile);
  const qualificationType =
    QUALIFICATION_TYPES.find(
      ({ value }) => value === profile.qualification?.type,
    )?.label ?? "Not recorded";
  const rows = [
    ["Name", `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()],
    ["Username", account.username],
    ["Roles", account.roles?.join(", ")],
    ["Status", accountStatusLabel(account)],
    ["Father’s given name", profile.fatherName],
    ["Mother’s name (given name only)", profile.motherName],
    ["Date of birth", profile.dateOfBirth],
    ["Address", profile.address],
    [
      phone.legacyInvalid
        ? `Phone — unverified / legacy invalid number (${phone.countryName})`
        : `Phone — unverified (${phone.countryName})`,
      phone.display,
    ],
    [
      `Individual email — ${contactLabel(profile.contactStatus?.email)}, contact only`,
      profile.email,
    ],
    ["Departments", profile.departments?.join(", ")],
    ["Employment start date", profile.employmentStartDate],
    ["Qualification type", qualificationType],
    ["Qualification level", profile.qualification?.level],
    ["Title / subject / branch", profile.qualification?.title],
    ["Awarding institution", profile.qualification?.institution],
  ];
  return (
    <dl className="staff-profile-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "Not recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function StaffProfile({ api, onError, onPendingChange }) {
  const id = useId();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [addressConflict, setAddressConflict] = useState(false);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const changeEmail = useRef(null),
    saving = useRef(false);
  const live = useRef(true);
  const page = useRef(null);
  const pendingChange = useRef(onPendingChange);
  pendingChange.current = onPendingChange;
  const reportError = useCallback(
    (failure) => {
      setError(managementErrorMessage(failure));
      if (isAccessError(failure)) onError?.(failure);
    },
    [onError],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.ownProfile();
      if (live.current) {
        setRecord(result);
        setAddress(result.profile.address);
      }
    } catch (failure) {
      if (live.current) reportError(failure);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [api, reportError]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      pendingChange.current?.(false);
    };
  }, [load]);
  useEffect(() => {
    if (!busy && !loading)
      page.current
        ?.querySelector(editing ? 'input[name="address"]' : "h1")
        ?.focus({ preventScroll: true });
  }, [busy, loading, editing]);
  async function refreshProfile() {
    try {
      const next = await api.ownProfile();
      if (!live.current) return false;
      const merged = refreshedAddress(record.profile, next.profile, address);
      setRecord(next);
      setAddress(merged.draft);
      setAddressConflict((current) => current || merged.conflict);
      setRefreshNeeded(false);
      setError("");
      return true;
    } catch (failure) {
      if (live.current) {
        setRefreshNeeded(true);
        setError(
          "Saved profile needs refreshing before you save your address. Your draft has been kept. " +
            managementErrorMessage(failure),
        );
        if (
          isAccessError(failure) &&
          !String(failure.code).includes("unavailable")
        )
          onError?.(failure);
      }
      return false;
    }
  }
  async function contactSaved(result) {
    setNotice(
      result.testOnly
        ? "Automated TEST result only. No real contact was verified."
        : `Email verified and saved. Recovery remains unavailable.${result.notificationWarning ? " The old-contact notification could not be sent." : ""}`,
    );

    return refreshProfile();
  }
  async function save(event) {
    event.preventDefault();
    if (saving.current || refreshNeeded || addressConflict || emailOpen) return;
    saving.current = true;
    pendingChange.current?.(true);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      assertManagementActionLive(live.current);
      const result = await api.updateOwnContact({
        expectedRevision: record.profile.revision,
        address: address.trim(),
      });
      if (live.current) {
        setRecord(result);
        setAddress(result.profile.address);
        setEditing(false);
        setNotice("Your address was updated. Saved contacts were not changed.");
      }
    } catch (failure) {
      if (live.current) reportError(failure);
    } finally {
      saving.current = false;
      if (live.current) {
        setBusy(false);
        pendingChange.current?.(false);
      }
    }
  }
  return (
    <section
      ref={page}
      className="staff-management-page"
      aria-labelledby={`${id}-title`}
    >
      <p className="staff-eyebrow">YOUR PRIVATE PERSONNEL RECORD</p>
      <h1 id={`${id}-title`} tabIndex={-1}>
        My Profile
      </h1>
      <p className="staff-intro">
        Every role can view its own complete profile. Your identity,
        qualifications and work details are read-only here. Only another Admin
        may change identity or qualifications.
      </p>
      <p className="staff-help">
        Legacy contacts remain unverified unless possession was confirmed
        through delivery. Phone changes are unavailable until real WhatsApp
        delivery is configured and successfully tested. No simulated delivery
        verifies your saved contacts or enables recovery.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="staff-notice" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading your profile…</p>
      ) : !record ? (
        <div className="staff-state">
          <p>Your profile could not be loaded.</p>
          <button
            className="staff-button"
            type="button"
            onClick={() => void load()}
          >
            Retry profile
          </button>
        </div>
      ) : (
        <>
          <ProfileDetails account={record.account} profile={record.profile} />
          {editing ? (
            <form onSubmit={save} className="staff-form staff-contact-editor">
              <h2>Edit profile</h2>
              <div className="staff-field">
                <label htmlFor={`${id}-address`}>Address</label>
                <input
                  id={`${id}-address`}
                  name="address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  required
                  disabled={busy}
                  autoComplete="off"
                />
              </div>
              <div className="staff-field">
                <label htmlFor={`${id}-email`}>
                  Saved email —{" "}
                  {contactLabel(record.profile.contactStatus?.email)}
                </label>
                <input
                  id={`${id}-email`}
                  type="email"
                  value={record.profile.email}
                  readOnly
                />
                <button
                  ref={changeEmail}
                  className="staff-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEmailOpen(true);
                    setError("");
                  }}
                >
                  Change email
                </button>
              </div>
              <div className="staff-field">
                <label htmlFor={`${id}-phone`}>
                  Saved phone — unverified
                  {savedPhone(record.profile).legacyInvalid
                    ? ` / legacy invalid number (${savedPhone(record.profile).countryName})`
                    : ` (${savedPhone(record.profile).countryName})`}
                </label>
                <input
                  id={`${id}-phone`}
                  type="tel"
                  value={record.profile.phone}
                  readOnly
                />
                <p className="staff-help">
                  Phone replacement is not available yet.
                </p>
              </div>
              <p className="staff-help">
                This form never changes saved email or phone. No password, role
                or account-status change is made.
              </p>
              {addressConflict && (
                <div className="staff-state" role="alert">
                  <p>
                    The saved address changed elsewhere. Your draft is still
                    here. Current saved address: {record.profile.address}
                  </p>
                  <button
                    className="staff-button"
                    type="button"
                    onClick={() => setAddressConflict(false)}
                  >
                    Use latest revision and keep my address draft
                  </button>
                </div>
              )}
              {(refreshNeeded || error) && (
                <button
                  className="staff-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void refreshProfile()}
                >
                  Refresh saved profile — keep address draft
                </button>
              )}
              <div className="staff-actions">
                <button
                  className="staff-button staff-button-primary"
                  type="submit"
                  disabled={busy || refreshNeeded || addressConflict}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
                <button
                  className="staff-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setAddress(record.profile.address);
                    setAddressConflict(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              className="staff-button staff-button-primary"
              type="button"
              onClick={() => {
                setAddress(record.profile.address);
                setEditing(true);
              }}
            >
              Edit profile
            </button>
          )}
          {emailOpen && (
            <ContactChange
              api={api}
              revision={record.profile.revision}
              roles={record.account.roles}
              onSaved={contactSaved}
              onRefresh={refreshProfile}
              onError={onError}
              onPendingChange={onPendingChange}
              onClose={() => setEmailOpen(false)}
              returnFocus={changeEmail}
            />
          )}
        </>
      )}
    </section>
  );
}
