import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { accountRequest } from "../patient-account-client.js";

export default function PatientPhoneVerification({ language, t, onVerified }) {
  const [state, setState] = useState(null);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState("");
  const [personal, setPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    accountRequest("phone-status", {}).then(
      (result) => {
        if (active) {
          setState(result.state);
          setReady(true);
        }
      },
      (failure) => {
        if (active) setError(failure.code ?? "try_later");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function submit(event, action, body) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await accountRequest(action, body);
      if (result.account) onVerified(result.account);
      else {
        setState(result.state);
        setCode("");
      }
    } catch (failure) {
      setError(failure.code ?? "try_later");
      if (action === "phone-verify") {
        const result = await accountRequest("phone-status", {}).catch(
          () => null,
        );
        if (result) setState(result.state);
      }
    } finally {
      setBusy(false);
    }
  }
  const canRequest = ready && (!state || state === "expired");
  return (
    <>
      {error && <Alert severity="error">{t(error)}</Alert>}
      {canRequest ? (
        <form
          className="request-fields"
          onSubmit={(event) =>
            submit(event, "phone-request", { personal, language })
          }
        >
          <label>
            <input
              type="checkbox"
              checked={personal}
              onChange={(event) => setPersonal(event.target.checked)}
            />{" "}
            {t("personalPhone")}
          </label>
          <div>
            <Button type="submit" variant="contained" disabled={busy}>
              {t(state === "expired" ? "requestNewCode" : "requestCode")}
            </Button>
          </div>
        </form>
      ) : state && state !== "verified" ? (
        <form
          className="request-fields"
          onSubmit={(event) => submit(event, "phone-verify", { code })}
        >
          <p role="status">{t("phoneCodeWaiting")}</p>
          <TextField
            label={t("phoneCode")}
            value={code}
            required
            onChange={(event) => setCode(event.target.value)}
            slotProps={{
              htmlInput: {
                inputMode: "numeric",
                autoComplete: "one-time-code",
                pattern: "[0-9]{6}",
                maxLength: 6,
                dir: "ltr",
              },
            }}
          />
          <div>
            <Button type="submit" variant="contained" disabled={busy}>
              {t("checkCode")}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
