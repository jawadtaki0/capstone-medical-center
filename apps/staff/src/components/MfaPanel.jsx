import { useEffect, useId, useState } from "react";
import QRCode from "qrcode";

export function MfaPanel({ enrollment, api, busy, onComplete, onBackup, onCancel, onError }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [seed, setSeed] = useState(null);
  const [qr, setQr] = useState("");
  const [qrUnavailable, setQrUnavailable] = useState(false);
  const [loading, setLoading] = useState(enrollment);
  useEffect(() => {
    if (!enrollment) return;
    let live = true;
    setLoading(true);
    // Defer the request so a discarded StrictMode effect does not start enrollment.
    Promise.resolve().then(() => live ? api.enrollment() : null).then(async (details) => {
      if (!live || !details) return;
      setSeed(details.secret);
      try {
        const image = await QRCode.toDataURL(details.otpauthUri, { width: 220, margin: 2, errorCorrectionLevel: "M" });
        if (live) setQr(image);
      } catch {
        // A QR rendering failure must not prevent manual authenticator enrollment.
        if (live) setQrUnavailable(true);
      }
      if (live) setLoading(false);
    }).catch((error) => { if (live) { setLoading(false); onError(error); } });
    return () => { live = false; };
  }, [enrollment, api, onError]);
  function submit(event) {
    event.preventDefault();
    const value = code.trim();
    setCode("");
    (useBackup ? onBackup : onComplete)({ code: value });
  }
  return <>
    <p className="staff-eyebrow">PRIVATE AUTHENTICATOR VERIFICATION</p>
    <h1>{enrollment ? "Connect your authenticator" : useBackup ? "Use a backup code" : "Enter your authenticator code"}</h1>
    {enrollment ? <>
      <p className="staff-intro">On your own authenticator app, add this account using the QR code or setup key. Keep this screen private; do not include it in screenshots or reports.</p>
      {loading && <p role="status">Preparing private enrollment…</p>}
      {seed && <div className="staff-enrollment">{qr && <img src={qr} width="220" height="220" alt="Private authenticator enrollment QR code" />}<div><h2>Manual setup key</h2><p className="staff-private-key">{seed}</p>{qrUnavailable && <p className="staff-help" role="status">The QR image could not be displayed. Add the manual key in your authenticator instead.</p>}<p className="staff-help">Enter the current 6-digit code below. The app works locally; authenticator codes do not need an email or internet connection.</p></div></div>}
    </> : <p className="staff-intro">{useBackup ? "Enter one of your private single-use backup codes. Your password has already been checked; the backup code replaces only the authenticator factor." : "Use the current 6-digit code from your authenticator app."}</p>}
    <form onSubmit={submit} className="staff-form"><div className="staff-field"><label htmlFor={`${id}-code`}>{useBackup ? "Single-use backup code" : "Authenticator code"}</label><input id={`${id}-code`} value={code} onChange={(event) => setCode(event.target.value)} type={useBackup ? "password" : "text"} inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" required spellCheck={false} autoCapitalize="none" disabled={busy || loading} maxLength={useBackup ? 128 : 6} pattern={useBackup ? undefined : "[0-9]{6}"} /></div>
      <button className="staff-button staff-button-primary" type="submit" disabled={busy || loading || (enrollment && !seed)}>{busy ? "Verifying…" : "Verify and continue"}</button></form>
    {!enrollment && <button className="staff-button staff-button-link" type="button" onClick={() => { setUseBackup(!useBackup); setCode(""); }} disabled={busy}>{useBackup ? "Use authenticator instead" : "Use one of my backup codes"}</button>}
    <button className="staff-button" type="button" onClick={onCancel} disabled={busy}>Cancel and return to sign in</button>
  </>;
}

export function BackupCodesPanel({ codes, busy, onAcknowledge, onCancel }) {
  const [saved, setSaved] = useState(false);
  const shownNow = codes.length > 0;
  return <>
    <p className="staff-eyebrow">PRIVATE · SHOWN ONCE</p>
    <h1>Save your backup codes</h1>
    {shownNow ? <><p className="staff-intro">Store these privately in your password manager or a secure offline place. Do not put them in screenshots, shared files, the project, or a report. Each code works once with your password.</p><ul className="staff-backup-codes" aria-label="Private single-use backup codes">{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul></> : <p className="staff-intro">Your codes were shown only once. If you did not save them, they cannot be recovered here. Your authenticator still works; code replacement is not part of this increment.</p>}
    <label className="staff-confirm"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} disabled={busy} />{shownNow ? "I saved these codes privately and understand they are shown once." : "I understand this limitation and have my authenticator available."}</label>
    <div className="staff-actions"><button className="staff-button staff-button-primary" type="button" disabled={!saved || busy} onClick={onAcknowledge}>{busy ? "Completing enrollment…" : shownNow ? "I saved my codes — open workspace" : "Continue to workspace"}</button><button className="staff-button" type="button" disabled={busy} onClick={onCancel}>Return to sign in</button></div>
  </>;
}
