import { randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { patientLinkEmail } from "./patient-email-templates.js";

const address = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;
const encodePart = (body) =>
  Buffer.from(body)
    .toString("base64")
    .match(/.{1,76}/g)
    .join("\r\n");

const oauthErrors = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
]);

function mailFailure(stage, reason) {
  const error = new Error("Patient mail delivery unavailable.");
  error.deliveryStage = stage;
  error.deliveryReason = reason;
  return error;
}

async function gmailRequest(stage, url, options) {
  const signal = AbortSignal.timeout(7000);
  try {
    const response = await fetch(url, {
      ...options,
      signal,
      redirect: "error",
    });
    if (stage === "oauth" && response.ok) {
      const { access_token: accessToken } = await response.json();
      if (typeof accessToken !== "string")
        throw mailFailure(stage, "invalid_response");
      return accessToken;
    }
    if (!response.ok) {
      let reason = "http_" + response.status;
      if (stage === "oauth") {
        const body = await response.json().catch(() => null);
        if (oauthErrors.has(body?.error)) reason = body.error;
      } else await response.body?.cancel();
      throw mailFailure(stage, reason);
    }
    await response.body?.cancel();
  } catch (error) {
    if (error.deliveryStage) throw error;
    throw mailFailure(
      stage,
      signal.aborted ? "timeout" : "network_or_invalid_response",
    );
  }
}

export function loadHostedPatientAccounts(
  environment,
  makeSes = (options) => new SESv2Client(options),
) {
  if (environment.CEDAR_PATIENT_ACCOUNTS !== "1") return {};
  const {
    CEDAR_PATIENT_PHONE_KEY: key,
    CEDAR_PATIENT_GMAIL_SENDER: sender,
    CEDAR_PATIENT_GMAIL_CLIENT_ID: clientId,
    CEDAR_PATIENT_GMAIL_CLIENT_SECRET: clientSecret,
    CEDAR_PATIENT_GMAIL_REFRESH_TOKEN: refreshToken,
  } = environment;
  const provider = environment.CEDAR_PATIENT_MAIL_PROVIDER ?? "gmail";
  if (!/^[A-Za-z0-9_-]{43}$/.test(key ?? ""))
    throw Error("Dedicated hosted patient phone-code configuration required.");
  const phoneKey = Buffer.from(key, "base64url");
  if (provider === "ses") {
    const {
      CEDAR_PATIENT_SES_REGION: region,
      CEDAR_PATIENT_SES_SENDER: from,
      CEDAR_PATIENT_SES_REPLY_TO: replyTo,
      CEDAR_PATIENT_SES_CONFIGURATION_SET: configurationSet,
      CEDAR_PATIENT_SES_ACCESS_KEY_ID: accessKeyId,
      CEDAR_PATIENT_SES_SECRET_ACCESS_KEY: secretAccessKey,
    } = environment;
    if (
      !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region ?? "") ||
      !address.test(from ?? "") ||
      !address.test(replyTo ?? "") ||
      !/^[a-z0-9_-]{1,64}$/i.test(configurationSet ?? "") ||
      !accessKeyId?.trim() ||
      !secretAccessKey?.trim()
    )
      throw Error("Dedicated hosted SES sending configuration required.");
    const client = makeSes({
      region,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
    });
    const patientAccountDelivery = async ({ to, purpose, link, language }) => {
        if (!address.test(to)) throw Error("Patient mail input unavailable.");
        const { subject, text, html } = patientLinkEmail({
          purpose,
          link,
          language,
        });
        const mailTraceId = randomUUID();
        function trace(event, details = {}) {
          console.info(
            JSON.stringify({ event, mailTraceId, purpose, ...details }),
          );
        }
        const signal = AbortSignal.timeout(7000);
        trace("patient_mail_ses_attempt");
        let result;
        try {
          result = await client.send(
            new SendEmailCommand({
              FromEmailAddress: `Cedar Medical Center <${from}>`,
              Destination: { ToAddresses: [to] },
              ReplyToAddresses: [replyTo],
              ConfigurationSetName: configurationSet,
              EmailTags: [
                { Name: "cedar-purpose", Value: purpose },
                { Name: "cedar-trace", Value: mailTraceId },
              ],
              Content: {
                Simple: {
                  Subject: { Data: subject, Charset: "UTF-8" },
                  Body: {
                    Text: { Data: text, Charset: "UTF-8" },
                    Html: { Data: html, Charset: "UTF-8" },
                  },
                },
              },
            }),
            { abortSignal: signal },
          );
        } catch (error) {
          const status = error?.$metadata?.httpStatusCode;
          const failure = mailFailure(
            "send",
            signal.aborted || error?.name === "TimeoutError"
              ? "timeout"
              : Number.isInteger(status) && status >= 100 && status <= 599
                ? `http_${status}`
                : "network_or_invalid_response",
          );
          trace("patient_mail_ses_unconfirmed", { reason: failure.deliveryReason });
          throw failure;
        }
        if (
          typeof result?.MessageId !== "string" ||
          !/^[a-z0-9-]{1,128}$/i.test(result.MessageId)
        ) {
          trace("patient_mail_ses_unconfirmed", { reason: "invalid_response" });
          throw mailFailure("send", "invalid_response");
        }
        trace("patient_mail_ses_accepted", { messageId: result.MessageId });
        return { mailTraceId };
    };
    return {
      phoneKey,
      patientAccountDelivery,
      labReportDelivery: (draft) =>
        patientAccountDelivery({ ...draft, purpose: "lab-report-ready" }),
    };
  }
  if (
    provider !== "gmail" ||
    !address.test(sender ?? "") ||
    ![clientId, clientSecret, refreshToken].every((value) => value?.trim())
  )
    throw Error(
      "Dedicated hosted patient mail and phone-code configuration required.",
    );
  return {
    phoneKey,
    patientAccountDelivery: async ({ to, purpose, link, language }) => {
      if (!address.test(to)) throw Error("Patient mail input unavailable.");
      const { subject, text, html } = patientLinkEmail({
        purpose,
        link,
        language,
      });
      const accessToken = await gmailRequest(
        "oauth",
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        },
      );
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
          `--${boundary}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          encodePart(html),
          `--${boundary}--`,
          "",
        ].join("\r\n"),
      ).toString("base64url");
      await gmailRequest(
        "send",
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
    },
  };
}
