import { useCallback, useEffect, useId, useRef, useState } from "react";
import StaffProfileFields from "./StaffProfileFields.jsx";
import { ProfileDetails } from "./StaffProfile.jsx";
import { suggestedUsername } from "../lib/profile.js";
import {
  accountStatusLabel,
  assertManagementActionLive,
  assignableRoles,
  canControlAccount,
  canReleaseEmail,
  canManageProfile,
  canManageIdentity,
  canManageWorkDetails,
  changedProfileFields,
  filterStaff,
  handoffExpiry,
  isAccessError,
  managementErrorMessage,
  managementProfile,
  STAFF_STATUS_OPTIONS,
  staffStatusKey,
  USERNAME_PATTERN,
  validateManagementProfile,
} from "../lib/staffManagement.js";

function PrivateSetupHandoff({ result, onClose }) {
  return (
    <section
      className="staff-private-handoff"
      aria-labelledby="staff-handoff-title"
    >
      <p className="staff-eyebrow">PRIVATE · INITIAL SETUP ONLY</p>
      <h2 id="staff-handoff-title">Privately hand over this setup code</h2>
      <p>
        Account: <strong>{result.account.username}</strong>
      </p>
      <p className="staff-private-key">{result.setupCode}</p>
      <p className="staff-help">
        Expires {handoffExpiry(result.expiresAt)} (Asia/Beirut). The employee
        enters their username and this single-use code, then chooses their own
        password. Administrative roles also complete MFA.
      </p>
      <p className="staff-help">
        Hand it over in person. Do not screenshot it, put it in project files,
        or share it in reports. Closing hides this code; it is not retrievable
        from the directory. An authorized replacement is possible only before a
        password is chosen.
      </p>
      <button
        className="staff-button staff-button-primary"
        type="button"
        onClick={onClose}
      >
        Close private handoff
      </button>
    </section>
  );
}

function CreateStaffForm({ roles, departments, busy, onSubmit, onCancel }) {
  const id = useId();
  const [names, setNames] = useState({ firstName: "", lastName: "" });
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [error, setError] = useState("");
  function nameChanged(key, value) {
    const next = { ...names, [key]: value };
    setNames(next);
    if (!usernameEdited)
      setUsername(
        suggestedUsername(next.firstName, next.lastName).slice(0, 40),
      );
  }
  function submit(event) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const profile = managementProfile(data),
      selectedRoles = data.getAll("roles");
    const validation = validateManagementProfile(profile, selectedRoles);
    if (validation) {
      setError(validation);
      return;
    }
    onSubmit({ username: username.trim(), roles: selectedRoles, profile });
  }
  return (
    <form className="staff-form" onSubmit={submit}>
      <h2>Create an individual account and profile</h2>
      <p className="staff-help">
        No password is chosen by the manager. The employee receives a private
        initial setup code.
      </p>
      <div className="staff-field">
        <label htmlFor={`${id}-username`}>Assigned username</label>
        <input
          id={`${id}-username`}
          value={username}
          onChange={(event) => {
            setUsernameEdited(true);
            setUsername(event.target.value);
          }}
          required
          pattern={USERNAME_PATTERN}
          maxLength={40}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <p className="staff-help">
          Suggested from first and last names; editable before creation, then
          fixed. Use 3–40 letters, digits, dots, underscores or hyphens.
          Uniqueness is checked by the server.
        </p>
      </div>
      <fieldset className="staff-fieldset" disabled={busy}>
        <legend>Explicit roles — choose at least one</legend>
        <div className="staff-checkboxes">
          {roles.map((role) => (
            <label key={role}>
              <input type="checkbox" name="roles" value={role} />
              {role}
            </label>
          ))}
        </div>
        <p className="staff-help">
          Each administrative role requires a relevant university degree.
          Selection never bypasses server authorization.
        </p>
      </fieldset>
      <StaffProfileFields
        departments={departments}
        disabled={busy}
        onNameChange={nameChanged}
      />
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      <div className="staff-actions">
        <button
          className="staff-button staff-button-primary"
          type="submit"
          disabled={busy}
        >
          {busy ? "Creating…" : "Create account and private setup code"}
        </button>
        <button
          className="staff-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel creation
        </button>
      </div>
    </form>
  );
}

function ManagedProfileEditor({
  record,
  departments,
  busy,
  identityLocked,
  workDetailsLocked,
  onSubmit,
  onCancel,
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  function submit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    const profile = managementProfile(new FormData(event.currentTarget), {
      includeEmail: false,
    });
    // Phone is saved contact information, not an editable delivery bypass.
    profile.phone = record.profile.phone;
    if (identityLocked) {
      for (const field of [
        "firstName",
        "lastName",
        "fatherName",
        "motherName",
        "dateOfBirth",
        "qualification",
      ])
        profile[field] = record.profile[field];
    }
    // Disabled department checkboxes are omitted by FormData. Restore the
    // displayed saved values so ordinary edits never submit a locked-field patch.
    if (workDetailsLocked) {
      profile.departments = [...record.profile.departments];
      profile.employmentStartDate = record.profile.employmentStartDate;
    }
    const validation = validateManagementProfile(
      profile,
      record.account.roles,
      record.profile.qualification,
      record.profile,
    );
    if (validation) {
      setError(validation);
      return;
    }
    const changes = changedProfileFields(profile, record.profile);
    if (!Object.keys(changes).length) {
      setNotice("No profile changes to save.");
      return;
    }
    onSubmit({
      accountId: record.account.id,
      expectedRevision: record.profile.revision,
      profile: changes,
    });
  }
  return (
    <form className="staff-form" onSubmit={submit}>
      <h2>Edit {record.account.name}’s private profile</h2>
      <p className="staff-help">
        Identity, family, department, employment and qualification changes
        require recent verification. Address-only edits do not. Account
        roles/status are separate controls; email and phone replacements are
        unavailable here.
      </p>
      <StaffProfileFields
        profile={record.profile}
        departments={departments}
        disabled={busy}
        emailLocked
        phoneLocked
        identityLocked={identityLocked}
        workDetailsLocked={workDetailsLocked}
      />
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
      <div className="staff-actions">
        <button
          className="staff-button staff-button-primary"
          type="submit"
          disabled={busy}
        >
          {busy ? "Saving…" : "Save staff profile"}
        </button>
        <button
          className="staff-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel profile edits
        </button>
      </div>
    </form>
  );
}

function AccountControls({ account, roles, busy, onConfirm, releaseEligible }) {
  const [validation, setValidation] = useState("");
  function roleSubmit(event) {
    event.preventDefault();
    setValidation("");
    const selectedRoles = new FormData(event.currentTarget).getAll("roles");
    if (!selectedRoles.length) {
      setValidation("Choose at least one role.");
      return;
    }
    if (
      selectedRoles.length === account.roles.length &&
      selectedRoles.every((role) => account.roles.includes(role))
    ) {
      setValidation("No role changes were selected.");
      return;
    }
    onConfirm({ kind: "roles", roles: selectedRoles });
  }
  return (
    <section
      className="staff-account-controls"
      aria-labelledby="staff-account-controls-title"
    >
      <h2 id="staff-account-controls-title">
        Separate protected account controls
      </h2>
      <p className="staff-help">
        You cannot manage your own account controls. Protected-role and
        last-Admin checks run on the server. Role/status changes invalidate old
        access and require fresh sign-in.
      </p>
      <form className="staff-form" onSubmit={roleSubmit}>
        <fieldset disabled={busy} className="staff-fieldset">
          <legend>Explicit assigned roles</legend>
          <div className="staff-checkboxes">
            {roles.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  name="roles"
                  value={role}
                  defaultChecked={account.roles.includes(role)}
                />
                {role}
              </label>
            ))}
          </div>
        </fieldset>
        {validation && (
          <p className="staff-error" role="alert">
            {validation}
          </p>
        )}
        <button type="submit" className="staff-button" disabled={busy}>
          Review role changes
        </button>
      </form>
      <div className="staff-actions">
        {releaseEligible && (
          <button
            className="staff-button staff-button-danger"
            type="button"
            disabled={busy}
            onClick={() => onConfirm({ kind: "email_release" })}
          >
            Review release verified email
          </button>
        )}
        <button
          className={`staff-button ${account.status === "disabled" ? "" : "staff-button-danger"}`}
          type="button"
          disabled={busy}
          onClick={() =>
            onConfirm({
              kind: "status",
              enabled: account.status === "disabled",
            })
          }
        >
          {account.status === "disabled"
            ? "Review re-enable account"
            : "Review disable account"}
        </button>
        {account.status === "setup_pending" && (
          <button
            className="staff-button"
            type="button"
            disabled={busy}
            onClick={() => onConfirm({ kind: "setup" })}
          >
            Review replacement setup code
          </button>
        )}
      </div>
      <p className="staff-help">
        Initial-code replacement is available only before password selection.
        Activated or interrupted-MFA accounts need the separately reviewed
        recovery/resumption flow, not a replacement password-setup code.
      </p>
    </section>
  );
}

function ActionConfirmation({ action, account, busy, onConfirm, onCancel }) {
  const title =
    action.kind === "email_release"
      ? "Confirm release verified email"
      : action.kind === "roles"
        ? "Confirm role changes"
        : action.kind === "setup"
          ? "Confirm replacement setup code"
          : action.enabled
            ? "Confirm re-enable account"
            : "Confirm disable account";
  return (
    <section
      className="staff-action-confirmation"
      aria-labelledby="staff-confirm-action-title"
    >
      <h2 id="staff-confirm-action-title">{title}</h2>
      <p>
        Target: <strong>{account.name}</strong> ({account.username}).
      </p>
      <p>
        {action.kind === "email_release"
          ? "This deactivated account will lose its verified email reservation. Its historical address and record remain, but the address will no longer be a verified contact. Pending contact requests are invalidated. Another employee must verify possession to claim it. Re-enabling this account will not restore ownership; it must obtain fresh verification of an available address. This does not enable recovery."
          : action.kind === "roles"
            ? `Resulting roles: ${action.roles.join(", ")}. Old sessions/challenges will be invalidated; any required MFA must be completed before new access.`
            : action.kind === "setup"
              ? "The previous unused setup code becomes invalid. The new single-use code expires after 30 minutes; the employee still chooses their own password."
              : action.enabled
                ? "Existing passwords and factors are preserved. Old sessions and challenges never return. An account without a password needs a separately issued setup code."
                : "Access and outstanding setup/authentication challenges are revoked immediately. Historical activity is retained; this is not deletion."}
      </p>
      <div className="staff-actions">
        <button
          className="staff-button staff-button-primary"
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Applying…" : title}
        </button>
        <button
          className="staff-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel account change
        </button>
      </div>
    </section>
  );
}

export default function StaffDirectory({
  api,
  user,
  onError,
  onSensitiveAction,
  onPendingChange,
}) {
  const id = useId();
  const [directory, setDirectory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState({
    query: "",
    role: "",
    department: "",
    status: "",
  });
  const [mode, setMode] = useState("list");
  const [record, setRecord] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [handoff, setHandoff] = useState(null);
  const live = useRef(true);
  const listRequest = useRef(0),
    detailRequest = useRef(0);
  const searchInput = useRef(null);
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
  const loadDirectory = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const data = await api.staffDirectory();
      if (live.current && request === listRequest.current) setDirectory(data);
    } catch (failure) {
      if (live.current && request === listRequest.current) reportError(failure);
    } finally {
      if (live.current && request === listRequest.current) setLoading(false);
    }
  }, [api, reportError]);
  useEffect(() => {
    let cancelled = false;
    live.current = true;
    Promise.resolve().then(() => {
      if (!cancelled) void loadDirectory();
    });
    return () => {
      cancelled = true;
      live.current = false;
      listRequest.current += 1;
      detailRequest.current += 1;
      pendingChange.current?.(false);
    };
  }, [loadDirectory]);
  useEffect(() => {
    if (busy || detailLoading) return;
    const target = page.current?.querySelector(
      handoff
        ? ".staff-private-handoff button"
        : confirmation
          ? ".staff-action-confirmation button"
          : "h1",
    );
    target?.focus({ preventScroll: true });
  }, [mode, busy, detailLoading, Boolean(handoff), Boolean(confirmation)]);
  async function openProfile(accountId) {
    const request = ++detailRequest.current;
    setSelectedId(accountId);
    setMode("view");
    setRecord(null);
    setDetailLoading(true);
    setError("");
    setConfirmation(null);
    setNotice("");
    try {
      const result = await api.staffProfile({ accountId });
      if (live.current && request === detailRequest.current) setRecord(result);
    } catch (failure) {
      if (live.current && request === detailRequest.current)
        reportError(failure);
    } finally {
      if (live.current && request === detailRequest.current)
        setDetailLoading(false);
    }
  }
  async function run(action, success) {
    pendingChange.current?.(true);
    setBusy(true);
    setError("");
    setNotice("");
    const guardedAction = () => {
      assertManagementActionLive(live.current);
      return action();
    };
    try {
      const result = await onSensitiveAction(guardedAction);
      if (live.current) await success(result);
    } catch (failure) {
      if (live.current) reportError(failure);
    } finally {
      if (live.current) {
        setBusy(false);
        pendingChange.current?.(false);
      }
    }
  }
  function returnToList() {
    detailRequest.current += 1;
    setMode("list");
    setRecord(null);
    setSelectedId(null);
    setConfirmation(null);
    setError("");
  }
  function create(payload) {
    return run(
      () => api.createStaff(payload),
      async (result) => {
        setHandoff(result);
        setMode("list");
        await loadDirectory();
      },
    );
  }
  function updateProfile(payload) {
    return run(
      () => api.updateStaffProfile(payload),
      async (result) => {
        setRecord(result);
        setMode("view");
        setNotice("Staff profile updated.");
        await loadDirectory();
      },
    );
  }
  function applyAccountChange() {
    const account = record.account,
      action = confirmation;
    const payload = { accountId: account.id, expectedVersion: account.version };
    const operation =
      action.kind === "email_release"
        ? () =>
            api.releaseStaffEmail({
              ...payload,
              expectedRevision: record.profile.revision,
              confirmed: true,
            })
        : action.kind === "roles"
          ? () => api.changeStaffRoles({ ...payload, roles: action.roles })
          : action.kind === "status"
            ? () =>
                api.changeStaffStatus({ ...payload, enabled: action.enabled })
            : () => api.replaceStaffSetupCode(payload);
    return run(operation, async (result) => {
      setConfirmation(null);
      if (action.kind === "setup") setHandoff(result);
      await openProfile(account.id);
      setNotice(
        action.kind === "email_release"
          ? "Verified email reservation released. Historical contact retained; ownership will not return on reactivation."
          : "Account change applied.",
      );
      await loadDirectory();
    });
  }
  const rows = directory ? filterStaff(directory.staff, filters) : [];
  const roleOptions = directory ? assignableRoles(user, directory.roles) : [];
  function setFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }
  return (
    <section
      ref={page}
      className="staff-management-page"
      aria-labelledby={`${id}-title`}
    >
      <p className="staff-eyebrow">AUTHORIZED PERSONNEL MANAGEMENT</p>
      <h1 id={`${id}-title`} tabIndex={-1}>
        Staff directory
      </h1>
      <p className="staff-intro">
        Directory summaries contain name, username, roles, departments and
        status only. Private personnel fields are available through authorized
        profile views; departments do not grant permissions.
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
      {handoff ? (
        <PrivateSetupHandoff
          result={handoff}
          onClose={() => setHandoff(null)}
        />
      ) : mode === "create" && directory ? (
        <CreateStaffForm
          roles={roleOptions}
          departments={directory.departments}
          busy={busy}
          onSubmit={create}
          onCancel={returnToList}
        />
      ) : mode === "view" || mode === "edit" ? (
        <>
          <button
            className="staff-button staff-management-back"
            type="button"
            disabled={busy}
            onClick={returnToList}
          >
            Back to staff directory
          </button>
          {detailLoading ? (
            <p role="status">Loading private profile…</p>
          ) : !record ? (
            <div className="staff-state">
              <p>The profile could not be loaded.</p>
              {selectedId && (
                <button
                  className="staff-button"
                  type="button"
                  onClick={() => void openProfile(selectedId)}
                >
                  Retry staff profile
                </button>
              )}
            </div>
          ) : (
            <>
              {mode === "edit" ? (
                <ManagedProfileEditor
                  key={`${record.account.id}:${record.profile.revision}`}
                  record={record}
                  departments={directory.departments}
                  busy={busy}
                  identityLocked={!canManageIdentity(user, record.account)}
                  workDetailsLocked={
                    !canManageWorkDetails(user, record.account)
                  }
                  onSubmit={updateProfile}
                  onCancel={() => {
                    setMode("view");
                    setError("");
                  }}
                />
              ) : (
                <>
                  <h2 className="staff-selected-profile-title">
                    {record.account.name}
                  </h2>
                  <ProfileDetails
                    account={record.account}
                    profile={record.profile}
                  />
                  {canManageProfile(user, record.account) ? (
                    <button
                      className="staff-button staff-button-primary"
                      type="button"
                      disabled={busy}
                      onClick={() => setMode("edit")}
                    >
                      Edit this staff profile
                    </button>
                  ) : (
                    <p className="staff-help">
                      This is your account. Use My Profile for address edits and
                      verified email replacement. Only another Admin may change
                      your identity or qualifications.
                    </p>
                  )}
                  {canControlAccount(user, record.account) ? (
                    confirmation ? (
                      <ActionConfirmation
                        action={confirmation}
                        account={record.account}
                        busy={busy}
                        onConfirm={applyAccountChange}
                        onCancel={() => setConfirmation(null)}
                      />
                    ) : (
                      <AccountControls
                        key={`${record.account.id}:${record.account.version}`}
                        account={record.account}
                        roles={roleOptions}
                        busy={busy}
                        releaseEligible={canReleaseEmail(user, record)}
                        onConfirm={setConfirmation}
                      />
                    )
                  ) : (
                    canManageProfile(user, record.account) && (
                      <p className="staff-help">
                        This account has a protected role. You can manage its
                        private profile, but only another authorized Admin can
                        change its account roles/status or issue its setup code.
                      </p>
                    )
                  )}
                </>
              )}
              {error && selectedId && (
                <button
                  className="staff-button"
                  type="button"
                  disabled={busy || detailLoading}
                  onClick={() => void openProfile(selectedId)}
                >
                  Reload current staff profile
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="staff-directory-toolbar">
            <button
              className="staff-button staff-button-primary"
              type="button"
              disabled={loading || !directory || busy}
              onClick={() => {
                setMode("create");
                setError("");
                setNotice("");
              }}
            >
              Create staff account
            </button>
            <button
              className="staff-button"
              type="button"
              disabled={loading || busy}
              onClick={() => {
                setError("");
                void loadDirectory();
              }}
            >
              Refresh directory
            </button>
          </div>
          {loading ? (
            <p role="status">Loading staff directory…</p>
          ) : !directory ? (
            <div className="staff-state">
              <p>The directory could not be loaded.</p>
              <button
                className="staff-button"
                type="button"
                onClick={() => {
                  setError("");
                  void loadDirectory();
                }}
              >
                Retry staff directory
              </button>
            </div>
          ) : (
            <>
              <div className="staff-directory-filters">
                <div className="staff-field staff-directory-search">
                  <label htmlFor={`${id}-search`}>Search staff</label>
                  <div className="staff-search-control">
                    <input
                      ref={searchInput}
                      id={`${id}-search`}
                      type="search"
                      value={filters.query}
                      onChange={(event) =>
                        setFilter("query", event.target.value)
                      }
                      aria-controls={`${id}-results`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {filters.query && (
                      <button
                        className="staff-button"
                        type="button"
                        aria-label="Clear staff search"
                        onClick={() => {
                          setFilter("query", "");
                          searchInput.current?.focus();
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div className="staff-field">
                  <label htmlFor={`${id}-role`}>Role</label>
                  <select
                    id={`${id}-role`}
                    value={filters.role}
                    onChange={(event) => setFilter("role", event.target.value)}
                  >
                    <option value="">All roles</option>
                    {directory.roles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="staff-field">
                  <label htmlFor={`${id}-department`}>Department</label>
                  <select
                    id={`${id}-department`}
                    value={filters.department}
                    onChange={(event) =>
                      setFilter("department", event.target.value)
                    }
                  >
                    <option value="">All departments</option>
                    {directory.departments.map((department) => (
                      <option key={department} value={department}>
                        {department}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="staff-field">
                  <label htmlFor={`${id}-status`}>Status</label>
                  <select
                    id={`${id}-status`}
                    value={filters.status}
                    onChange={(event) =>
                      setFilter("status", event.target.value)
                    }
                  >
                    <option value="">All statuses</option>
                    {STAFF_STATUS_OPTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {(filters.status === "unknown" ||
                      directory.staff.some(
                        (person) => staffStatusKey(person) === "unknown",
                      )) && <option value="unknown">Unknown status</option>}
                  </select>
                </div>
              </div>
              <p className="staff-result-count" role="status">
                {rows.length}{" "}
                {rows.length === 1 ? "staff member" : "staff members"} shown.
              </p>
              <div id={`${id}-results`}>
                {directory.staff.length === 0 ? (
                  <p className="staff-state">
                    No staff accounts are available.
                  </p>
                ) : rows.length === 0 ? (
                  <div className="staff-state">
                    <p>No staff match your search and filters.</p>
                    <button
                      className="staff-button"
                      type="button"
                      onClick={() => {
                        setFilters({
                          query: "",
                          role: "",
                          department: "",
                          status: "",
                        });
                        searchInput.current?.focus();
                      }}
                    >
                      Clear search and filters
                    </button>
                  </div>
                ) : (
                  <ul className="staff-directory-list">
                    {rows.map((person) => (
                      <li key={person.id}>
                        <article className="staff-directory-row">
                          <div className="staff-directory-name">
                            <h2>{person.name}</h2>
                            <p>{person.username}</p>
                          </div>
                          <dl>
                            <div>
                              <dt>Roles</dt>
                              <dd>{person.roles.join(", ")}</dd>
                            </div>
                            <div>
                              <dt>Departments</dt>
                              <dd>
                                {person.departments.join(", ") ||
                                  "Not recorded"}
                              </dd>
                            </div>
                            <div>
                              <dt>Status</dt>
                              <dd>
                                <span
                                  className={`staff-account-status staff-account-status-${staffStatusKey(person)}`}
                                >
                                  {accountStatusLabel(person)}
                                </span>
                              </dd>
                            </div>
                          </dl>
                          <button
                            type="button"
                            className="staff-button"
                            aria-label={`View profile for ${person.name}`}
                            onClick={() => void openProfile(person.id)}
                          >
                            View profile
                          </button>
                        </article>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
