import { useEffect, useRef, useState } from "react";
import { managementErrorMessage } from "../lib/staffManagement.js";

export default function StaffPhoneVerification({
  account,
  api,
  onSensitiveAction,
  onError,
}) {
  const live = useRef(false),
    inFlight = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function open() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await onSensitiveAction(() => {
        if (!live.current)
          throw Error("Reopen this staff record before sending a phone code.");
        return api.openStaffPhoneWhatsApp({ accountId: account.id });
      });
      if (live.current && result?.opened)
        setNotice(
          result.warning ||
            "WhatsApp link opened. Check the destination and manually press Send. Opening does not confirm sending or phone ownership.",
        );
    } catch (failure) {
      if (live.current) {
        setError(managementErrorMessage(failure));
        onError?.(failure);
      }
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="staff-workspace-card">
      <h3>Phone verification assistance</h3>
      <p>
        The employee must first request Verify phone number in My Profile and
        keep that sign-in open. Another Admin can send the prepared code to
        their saved phone. The employee enters the code they receive.
      </p>
      <p className="staff-help">
        The sender is the WhatsApp account signed in on this computer. This
        action does not send automatically or replace a phone number. Do not
        read or share the code with the employee through another channel.
      </p>
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="staff-notice">
          {notice}
        </p>
      )}
      <button
        type="button"
        className="staff-button"
        disabled={busy}
        onClick={() => void open()}
      >
        {busy
          ? "Preparing WhatsApp…"
          : "Send phone verification code via WhatsApp"}
      </button>
    </section>
  );
}
