import { randomBytes } from "node:crypto";
import { connectStaffDatabase } from "../src/db.js";
import { createVault } from "../src/local-security.js";
import { createAuthService } from "../src/auth.js";
import { privateRecoveryForm } from "./private-recovery-form.js";

async function run() {
  if (process.platform !== "win32" || !process.argv.includes("--demo-loopback"))
    throw new Error("Explicit same-computer Windows demo mode is required.");
  const action = process.argv.find((value) =>
    [
      "--provision",
      "--rotate",
      "--revoke",
      "--redeem",
      "--resume",
      "--check-form",
    ].includes(value),
  );
  if (!action)
    throw new Error(
      "Select --provision, --rotate, --revoke, --redeem, --resume or --check-form. Never supply private values as arguments.",
    );
  if (action === "--check-form") {
    await privateRecoveryForm({
      note: "Popup check only. Enter no secrets. Cancel/Escape closes without saving.",
      fields: [
        {
          label: "No account or database is accessed",
          readOnly: true,
          value: "Private form check",
        },
      ],
      expiryMs: 60000,
    });
    console.log("Private popup check finished; nothing changed.");
    return;
  }
  let connection, vault, bearer;
  try {
    connection = await connectStaffDatabase({ demoMode: true });
    vault = createVault(connection.config.key);
    const auth = createAuthService({
      db: connection.db,
      client: connection.client,
      vault,
    });
    let result;
    if (["--provision", "--rotate", "--revoke"].includes(action)) {
      const values = await privateRecoveryForm({
        note: "Another active Admin must authenticate. No passwords, tokens or factors are printed or exported.",
        fields: [
          { label: "Admin username" },
          { label: "Current password", private: true },
          { label: "MFA method: totp or backup", value: "totp" },
          {
            label: "Current authenticator / unused backup code",
            private: true,
          },
        ],
      });
      if (!values) return;
      try {
        const login = await auth.login(
          { username: values[0], password: values[1] },
          "private-operator",
        );
        const verified =
          values[2] === "backup"
            ? await auth.useBackup(
                { challenge: login.challenge, code: values[3] },
                "private-operator",
              )
            : await auth.completeMfa(
                { challenge: login.challenge, code: values[3] },
                "private-operator",
              );
        bearer = verified.token;
      } finally {
        values.fill("");
      }
      if (action === "--revoke") {
        const confirmation = await privateRecoveryForm({
          note: "Revocation leaves no emergency bypass. Confirm the CEO has been informed.",
          fields: [
            { label: "Type REVOKE to revoke the current emergency key" },
          ],
        });
        if (!confirmation || confirmation[0] !== "REVOKE") return;
        await auth.emergency.revoke(bearer, { confirmed: true });
        console.log("Emergency key revoked. No account or factor was reset.");
        return;
      }
      const prepared = await auth.emergency.prepare(bearer, {
        confirmedCEO: true,
        replace: action === "--rotate",
      });
      const custody = await privateRecoveryForm({
        note: "CEO custody: write/print a sealed copy, store in the locked safe separately from the server. Theft of this bearer can authorize recovery. Software cannot prove the holder is the CEO. Do not screenshot or auto-export.",
        expiresAt: prepared.expiresAt,
        fields: [
          {
            label: "Private emergency secret (shown once)",
            readOnly: true,
            value: prepared.secret,
          },
          { label: "Type CEO CUSTODY CONFIRMED after secure private storage" },
        ],
      });
      if (!custody || custody[1] !== "CEO CUSTODY CONFIRMED") return;
      await auth.emergency.acknowledge(bearer, {
        proof: prepared.proof,
        custodyConfirmed: true,
      });
      prepared.secret = "";
      prepared.proof = "";
      custody.fill("");
      console.log(
        "Emergency custody acknowledged. Previous key is invalid. No recovery was performed.",
      );
      return;
    }
    if (action === "--redeem") {
      const resumeSecret = randomBytes(32).toString("base64url");
      const values = await privateRecoveryForm({
        note: "Emergency use only. Software cannot determine that no Admin can sign in. Privately store the separate resume secret BEFORE confirming; it resumes only this recovery after a crash, never workspace access.",
        fields: [
          { label: "CEO-held emergency key", private: true },
          { label: "Existing active Admin username" },
          { label: "Scope: password, mfa or both", value: "both" },
          {
            label: "Separate private resume secret (store before confirmation)",
            readOnly: true,
            value: resumeSecret,
          },
          { label: "Type EMERGENCY AND RESUME CUSTODY CONFIRMED" },
        ],
      });
      if (!values || values[4] !== "EMERGENCY AND RESUME CUSTODY CONFIRMED")
        return;
      try {
        result = await auth.emergency.redeem({
          secret: values[0],
          username: values[1],
          scope: values[2],
          emergencyAcknowledged: true,
          resumeSecret,
          resumeCustodyConfirmed: true,
        });
      } finally {
        values.fill("");
      }
    } else {
      const values = await privateRecoveryForm({
        note: "Resume the same already-authorized emergency case. The consumed emergency key cannot be replayed.",
        fields: [
          { label: "Separately held case resume secret", private: true },
          { label: "Type EMERGENCY RESUMPTION CONFIRMED" },
        ],
      });
      if (!values || values[1] !== "EMERGENCY RESUMPTION CONFIRMED") return;
      try {
        result = await auth.emergency.resume({
          resumeSecret: values[0],
          emergencyAcknowledged: true,
        });
      } finally {
        values.fill("");
      }
    }
    await privateRecoveryForm({
      note: "Hand this restricted token privately to the employee. They enter it in Recover access → Use private recovery handoff. It does not authorize workspace access. After recovery, authenticate and rotate/provision a replacement CEO key with explicit custody acknowledgement.",
      expiryMs: Math.min(60000, Date.parse(result.expiresAt) - Date.now()),
      fields: [
        {
          label: "Private employee handoff token",
          readOnly: true,
          value: result.handoff,
        },
      ],
    });
    result.handoff = "";
    console.log(
      "Private handoff display closed. No secret was printed or exported.",
    );
  } finally {
    if (bearer && connection && vault) {
      try {
        await createAuthService({
          db: connection.db,
          client: connection.client,
          vault,
        }).logout(bearer);
      } catch {
        /* No restored authority. */
      }
    }
    await connection?.client.close();
    vault?.destroy();
  }
}
run().catch(() => {
  console.error(
    "Recovery tooling could not complete safely. Check local readiness, Admin verification, deadlines and private custody. Nothing was bypassed; never share secrets to diagnose this error.",
  );
  process.exitCode = 1;
});
