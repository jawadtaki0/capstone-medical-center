const address = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;
const subjects = {
  activate: ["Activate your Cedar account", "فعّل حسابك في سيدر"],
  reset: ["Reset your Cedar password", "أعد تعيين كلمة مرور سيدر"],
  "verify-email": ["Verify your new Cedar email", "تحقق من بريد سيدر الجديد"],
};

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
    patientAccountDelivery: async ({ to, purpose, link, language }) => {
      if (!address.test(to) || !Object.hasOwn(subjects, purpose))
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
      const subject = subjects[purpose][language === "ar" ? 1 : 0];
      const body = Buffer.from(`${subject}\r\n\r\n${link}\r\n`)
        .toString("base64")
        .match(/.{1,76}/g)
        .join("\r\n");
      const raw = Buffer.from(
        [
          `From: Cedar Medical Center <${sender}>`,
          `To: <${to}>`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          body,
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
