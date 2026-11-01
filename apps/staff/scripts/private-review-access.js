// Private synthetic operator UI only. Never imported by Electron or a server route.
import { generate } from "otplib";
import { privateRecoveryForm } from "../../staff-api/scripts/private-recovery-form.js";

export function currentReviewCode(periods, now = Date.now()) {
  return (
    periods.find(
      (p) => Date.parse(p.validFrom) <= now && now < Date.parse(p.validUntil),
    ) ?? null
  );
}
export async function buildReviewAccessOptions(
  saved,
  { now = Date.now() } = {},
) {
  const valid = (p) =>
    p &&
    typeof p.username === "string" &&
    p.username.startsWith("synthetic.") &&
    typeof p.password === "string" &&
    p.password.length > 0 &&
    p.password.length <= 512;
  if (
    saved?.version !== 1 ||
    saved.syntheticOnly !== true ||
    !valid(saved.admin) ||
    !valid(saved.receptionist) ||
    !/^[A-Z2-7]{16,128}$/.test(saved.admin.secret ?? "") ||
    !Array.isArray(saved.admin.backupCodes) ||
    saved.admin.backupCodes.length > 20 ||
    saved.admin.backupCodes.some(
      (c) => typeof c !== "string" || !c || c.length > 100,
    ) ||
    !Number.isFinite(now)
  )
    throw Error("Synthetic review access format refused.");
  const start = Math.floor(now / 30000) * 30000,
    end = Math.floor((now + 300000) / 30000) * 30000;
  const reviewCodePeriods = [];
  for (let at = start; at < end; at += 30000)
    reviewCodePeriods.push({
      validFrom: new Date(at).toISOString(),
      validUntil: new Date(at + 30000).toISOString(),
      code: await generate({
        secret: saved.admin.secret,
        epoch: Math.floor(at / 1000),
        period: 30,
        digits: 6,
      }),
    });
  const field = (label, value, privateValue, extra = {}) => ({
    label,
    value,
    private: privateValue,
    readOnly: true,
    copyValue: true,
    copyLabel: privateValue ? "Copy password" : "Copy username",
    ...extra,
  });
  return {
    purpose: "hosted-review",
    reviewDisplay: true,
    reviewCodePeriods,
    expiresAt: new Date(end).toISOString(),
    note: "SYNTHETIC REVIEW ONLY. Sign in with Current sign-in code, not the setup key. Codes refresh automatically; copy again after refresh. Previously consumed backup codes remain invalid. Never share/screenshot. Replace clipboard contents after use.",
    fields: [
      field("Review Admin username", saved.admin.username, false, {
        section: "Admin sign-in",
      }),
      field("Review Admin password", saved.admin.password, true),
      field(
        "Current sign-in code (six digits)",
        currentReviewCode(reviewCodePeriods, now).code,
        true,
        {
          currentCode: true,
          initialVisible: true,
          copyLabel: "Copy current code",
        },
      ),
      field(
        "Review Receptionist username",
        saved.receptionist.username,
        false,
        { section: "Receptionist sign-in" },
      ),
      field("Review Receptionist password", saved.receptionist.password, true),
      field("Authenticator setup key", saved.admin.secret, true, {
        section: "Optional authenticator setup — NOT the sign-in code",
        copyLabel: "Copy setup key",
      }),
      ...saved.admin.backupCodes.map((code, i) =>
        field(
          `Initial backup code ${i + 1} (may already be consumed)`,
          code,
          true,
          {
            ...(i === 0
              ? {
                  section:
                    "Initial backup codes — consumed codes remain invalid",
                }
              : {}),
            copyLabel: `Copy code ${i + 1}`,
          },
        ),
      ),
    ],
  };
}
export async function showSyntheticReviewAccess(saved) {
  const options = await buildReviewAccessOptions(saved);
  await privateRecoveryForm(options);
}
