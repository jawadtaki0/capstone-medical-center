import { useId, useState } from "react";
import { setupProfile, STAFF_DEPARTMENTS, suggestedUsername } from "../lib/profile.js";

export function SignInForm({ busy, onSubmit, setupAvailable, onSetup }) {
  const id = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  function submit(event) {
    event.preventDefault();
    const credentials = { username: username.trim(), password };
    setPassword("");
    onSubmit(credentials);
  }
  return <>
    <p className="staff-eyebrow">INDIVIDUAL STAFF ACCESS</p>
    <h1>Sign in to Cedar Staff</h1>
    <p className="staff-intro">Use your assigned username. Administrative roles also require authenticator verification.</p>
    <form onSubmit={submit} className="staff-form">
      <div className="staff-field"><label htmlFor={`${id}-username`}>Username</label><input id={`${id}-username`} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={busy} /></div>
      <div className="staff-field"><label htmlFor={`${id}-password`}>Password or passphrase</label><input id={`${id}-password`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} /></div>
      <button className="staff-button staff-button-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
    </form>
    <p className="staff-help">If first setup stopped during MFA enrollment, sign in with the username and password you already chose. Do not create another administrator.</p>
    {setupAvailable && <button className="staff-button staff-button-link" type="button" onClick={onSetup} disabled={busy}>Use the private first-Admin setup code</button>}
  </>;
}

export function SetupForm({ busy, onSubmit, onCancel }) {
  const id = useId();
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [names, setNames] = useState({ firstName: "", lastName: "" });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  function nameChanged(key, value) {
    const next = { ...names, [key]: value };
    setNames(next);
    if (!usernameEdited) setUsername(suggestedUsername(next.firstName, next.lastName));
  }
  function submit(event) {
    event.preventDefault();
    setError("");
    const profile = setupProfile(new FormData(event.currentTarget));
    if (!profile.departments.length) { setError("Choose at least one department."); return; }
    if (password !== confirmation) { setError("The passwords do not match."); return; }
    if ([...password].length < 15 || [...password].length > 128) { setError("Use a password or passphrase of 15–128 characters."); return; }
    const payload = { code: code.trim(), username: username.trim(), password, profile };
    setPassword(""); setConfirmation(""); setCode("");
    onSubmit(payload);
  }
  const field = (key, label, type = "text", autoComplete = "off") => <div className="staff-field" key={key}>
    <label htmlFor={`${id}-${key}`}>{label}</label>
    <input id={`${id}-${key}`} name={key} type={type} autoComplete={autoComplete} required disabled={busy} />
  </div>;
  return <>
    <p className="staff-eyebrow">ONE-TIME INSTALLATION SETUP</p>
    <h1>Set up the first Admin</h1>
    <p className="staff-intro">Use the private installation code and synthetic profile information for this development demonstration. This is not public registration.</p>
    <form onSubmit={submit} className="staff-form">
      <fieldset disabled={busy} className="staff-fieldset"><legend>Individual staff profile</legend><div className="staff-form-grid">
        {[["firstName", "First name"], ["lastName", "Last name"]].map(([key, label]) => <div className="staff-field" key={key}><label htmlFor={`${id}-${key}`}>{label}</label><input id={`${id}-${key}`} name={key} value={names[key]} onChange={(event) => nameChanged(key, event.target.value)} required autoComplete="off" /></div>)}
        {field("fatherName", "Father’s given name")}{field("motherName", "Mother’s name (given name only)")}
        {field("dateOfBirth", "Date of birth", "date")}{field("employmentStartDate", "Employment start date", "date")}
        {field("address", "Address")}{field("phone", "Phone", "tel")}{field("email", "Individual email", "email")}
      </div><p className="staff-help">Email is contact information only. It is not verified for recovery in this increment. Parents’ names and date of birth are never recovery answers.</p></fieldset>
      <fieldset className="staff-fieldset" disabled={busy}><legend>Departments — choose at least one</legend><div className="staff-checkboxes">
        {STAFF_DEPARTMENTS.map((department) => <label key={department}><input type="checkbox" name="departments" value={department} />{department}</label>)}
      </div><p className="staff-help">Departments describe assignments; they do not grant permissions.</p></fieldset>
      <fieldset className="staff-fieldset" disabled={busy}><legend>University qualification</legend><p className="staff-help">An Admin requires a relevant university degree. No certificates or identity scans are uploaded.</p><div className="staff-form-grid">{field("qualificationTitle", "Degree title / subject")}{field("qualificationInstitution", "Awarding university / institution")}</div></fieldset>
      <fieldset className="staff-fieldset" disabled={busy}><legend>Private sign-in credentials</legend>
        <div className="staff-field"><label htmlFor={`${id}-username`}>Username</label><input id={`${id}-username`} value={username} onChange={(event) => { setUsernameEdited(true); setUsername(event.target.value); }} required autoComplete="username" autoCapitalize="none" spellCheck={false} /><p className="staff-help">The suggested username is editable now and fixed after account creation.</p></div>
        <div className="staff-field"><label htmlFor={`${id}-code`}>Private single-use setup code</label><input id={`${id}-code`} type="password" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" required /></div>
        <div className="staff-form-grid"><div className="staff-field"><label htmlFor={`${id}-password`}>Choose a password or passphrase</label><input id={`${id}-password`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></div><div className="staff-field"><label htmlFor={`${id}-confirm`}>Confirm password</label><input id={`${id}-confirm`} type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required /></div></div>
        <p className="staff-help">15–128 characters; spaces and password managers are welcome. Do not use a shared or preset password.</p>
      </fieldset>
      {error && <p className="staff-error" role="alert">{error}</p>}
      <div className="staff-actions"><button className="staff-button staff-button-primary" type="submit" disabled={busy}>{busy ? "Checking setup…" : "Set password and continue to MFA"}</button><button className="staff-button" type="button" onClick={onCancel} disabled={busy}>Back to sign in</button></div>
    </form>
  </>;
}
