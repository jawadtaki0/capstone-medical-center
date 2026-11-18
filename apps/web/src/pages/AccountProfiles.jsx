import { useState } from "react";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import PatientDetailsFields from "../request-preview/PatientDetailsFields.jsx";
import {
  childBirthDateAllowed,
  patientInput,
  patientToday,
  PATIENT_FIELDS,
} from "../../../staff/shared/patient-input.js";
import { accountRequest } from "../patient-account-client.js";

export function AddProfiles({ account, language, t, onSaved, onCancel }) {
  const hasSelf = account.profiles.some(
    (profile) => profile.relationship === "self",
  );
  const [choice, setChoice] = useState(hasSelf ? "child" : "self");
  const [details, setDetails] = useState(() => {
    const empty = Object.fromEntries(
      PATIENT_FIELDS.map((field) => [field, ""]),
    );
    return { self: empty, child: empty };
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const roles = choice === "both" ? ["self", "child"] : [choice];
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setFailure("");
    const today = patientToday();
    const problems = {};
    for (const role of roles) {
      const { errors: fields } = patientInput(
        {
          ...details[role],
          phone: account.bookingPhone ?? account.pendingPhone,
        },
        today,
      );
      delete fields.phone;
      if (
        role === "child" &&
        !fields.dateOfBirth &&
        !childBirthDateAllowed(details[role].dateOfBirth, today)
      )
        fields.dateOfBirth = "invalid_child_birth_date";
      problems[role] = fields;
    }
    setErrors(problems);
    if (Object.values(problems).some((fields) => Object.keys(fields).length))
      return;
    setBusy(true);
    try {
      const result = await accountRequest("add-profiles", {
        profiles: roles.map((relationship) => ({
          relationship,
          patient: details[relationship],
        })),
      });
      onSaved(result.account);
    } catch (error) {
      setFailure(error.code ?? "try_later");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="request-fields" onSubmit={save}>
      {failure && <Alert severity="error">{t(failure)}</Alert>}
      <TextField
        select
        label={t("relationship")}
        value={choice}
        disabled={busy}
        onChange={(event) => setChoice(event.target.value)}
        slotProps={{ select: { native: true } }}
      >
        {!hasSelf && <option value="self">{t("self")}</option>}
        <option value="child">{t("child")}</option>
        {!hasSelf && <option value="both">{t("both")}</option>}
      </TextField>
      {roles.map((role) => (
        <fieldset className="request-fields" key={role} disabled={busy}>
          <legend>{t(role)}</legend>
          {role === "child" && <small>{t("childAgeHint")}</small>}
          <PatientDetailsFields
            details={details[role]}
            errors={errors[role] ?? {}}
            language={language}
            edit={(key, value) => {
              setDetails({
                ...details,
                [role]: { ...details[role], [key]: value },
              });
              setErrors({
                ...errors,
                [role]: { ...errors[role], [key]: undefined },
              });
            }}
            showPhone={false}
            dateAllowed={role === "child" ? childBirthDateAllowed : undefined}
            dateError={
              errors[role]?.dateOfBirth === "invalid_child_birth_date"
                ? t("invalid_child_birth_date")
                : undefined
            }
          />
        </fieldset>
      ))}
      <div className="request-actions">
        <Button variant="contained" type="submit" disabled={busy}>
          {t("saveProfiles")}
        </Button>
        <Button type="button" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

export function AccountProfiles({ account, language, t }) {
  const [expanded, setExpanded] = useState(null);
  async function viewRequests(id) {
    setExpanded({ id });
    try {
      const { requests } = await accountRequest("profile-requests", {
        profileId: id,
      });
      setExpanded((state) => (state?.id === id ? { id, requests } : state));
    } catch {
      setExpanded((state) => (state?.id === id ? { id, error: true } : state));
    }
  }
  return (
    <div className="request-fields">
      {account.profiles.map((profile) => (
        <section className="request-alert" key={profile.id}>
          <h2>
            <bdi>
              {profile.firstName} {profile.lastName}
            </bdi>
          </h2>
          <p>{t(profile.relationship)}</p>
          <div className="request-actions">
            {account.bookingPhone && (
              <Button
                variant="contained"
                href={`/request?profile=${profile.id}&lang=${language}`}
              >
                {t("requestSession")}
              </Button>
            )}
            <Button
              variant="outlined"
              aria-expanded={expanded?.id === profile.id}
              onClick={() =>
                expanded?.id === profile.id
                  ? setExpanded(null)
                  : viewRequests(profile.id)
              }
            >
              {t("viewRequests")}
            </Button>
          </div>
          {expanded?.id === profile.id && (
            <div aria-live="polite">
              {expanded.error ? (
                <p>{t("try_later")}</p>
              ) : !expanded.requests ? (
                <p>{t("busy")}</p>
              ) : !expanded.requests.length ? (
                <p>{t("noRequests")}</p>
              ) : (
                <ul>
                  {expanded.requests.map((request) => (
                    <li key={request.reference}>
                      <bdi>
                        {request.professional} · {request.date} ·{" "}
                        {request.startTime}–{request.endTime}
                      </bdi>
                      {" · "}
                      {t(request.status)}
                      {" · "}
                      <bdi>{request.reference}</bdi>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
