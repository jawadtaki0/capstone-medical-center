import { randomUUID } from "node:crypto";
import { patientLinkEmail } from "./patient-email-templates.js";

const address = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;
const encodePart = (body) =>
  Buffer.from(body)
    .toString("base64")
    .match(/.{1,76}/g)
    .join("\r\n");

export function loadHostedPatientAccounts(environment) {
  if (environment.CEDAR_PATIENT_ACCOUNTS !== "1") return {};
  const {
    CEDAR_PATIENT_PHONE_KEY: key,
    CEDAR_PATIENT_GMAIL_SENDER: sender,
    CEDAR_PATIENT_GMAIL_CLIENT_ID: clientId,
    CEDAR_PATIENT_GMAIL_CLIENT_SECRET: clientSecret,
    CEDAR_PATIENT_GMAIL_REFRESH_TOKEN: refreshToken,
  } = environment;
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(key ?? "") ||
    !address.test(sender ?? "") ||
    ![clientId, clientSecret, refreshToken].every((value) => value?.trim())
  )
    throw Error(
      "Dedicated hosted patient mail and phone-code configuration required.",
    );
  return {
    phoneKey: Buffer.from(key, "base64url"),
    patientAccountDelivery: async ({
      to,
      purpose,
      link,
      language,
      subject: cancellationSubject,
      message,
    }) => {
      if (!address.test(to)) throw Error("Patient mail input unavailable.");
      const cancellation = purpose === "booking-cancellation";
      const { subject, text, html } = cancellation
        ? { subject: cancellationSubject, text: message }
        : patientLinkEmail({ purpose, link, language });
      if (
        typeof subject !== "string" ||
        !subject ||
        typeof text !== "string" ||
        !text
      )
        throw Error("Patient mail input unavailable.");
      const token = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(7000),
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!token.ok) throw Error("Patient mail authorization unavailable.");
      const { access_token: accessToken } = await token.json();
      if (typeof accessToken !== "string")
        throw Error("Patient mail authorization unavailable.");
      const boundary = `cedar-${randomUUID()}`;
      const raw = Buffer.from(
        [
          `From: Cedar Medical Center <${sender}>`,
          `To: <${to}>`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          encodePart(text),
          ...(html
            ? [
                `--${boundary}`,
                "Content-Type: text/html; charset=UTF-8",
                "Content-Transfer-Encoding: base64",
                "",
                encodePart(html),
              ]
            : []),
          `--${boundary}--`,
          "",
        ].join("\r\n"),
      ).toString("base64url");
      const result = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(7000),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
      if (!result.ok) throw Error("Patient mail delivery unavailable.");
      await result.body?.cancel();
    },
  };
}
