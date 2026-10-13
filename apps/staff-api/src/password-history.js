import * as argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { unavailable } from "./errors.js";

// One sequential cursor, unchanged Argon2 verification, no history truncation.
// Callers supply their own live authority check at every expensive boundary.
export async function checkRecordedPasswords({
  password,
  currentHash,
  cursor,
  vault,
  check,
  work,
}) {
  try {
    let reused = await work("history-current", () =>
      argon2.verify(currentHash, password),
    );
    for await (const entry of cursor) {
      if (reused) break;
      await check();
      if (!Number.isInteger(entry.credentialVersion) || !entry.hashCipher)
        throw unavailable();
      const hash = vault.decrypt(entry.hashCipher);
      if (!hash.startsWith("$argon2id$")) throw unavailable();
      reused = await work("history", () => argon2.verify(hash, password));
    }
    await check();
    return reused;
  } finally {
    await cursor.close();
  }
}

export async function archiveCurrentPassword(db, vault, session, account, at) {
  await db.collection("staff_password_history").insertOne(
    {
      _id: randomUUID(),
      accountId: account._id,
      credentialVersion: account.version,
      hashCipher: vault.encrypt(account.passwordHash),
      retiredAt: at,
    },
    { session },
  );
}

// Credential changes invalidate recovery too. Keep historical events/counters.
export async function revokeCredentialAuthorities(
  db,
  session,
  accountId,
  at,
  reason,
) {
  await db
    .collection("staff_sessions")
    .updateMany(
      { accountId, revokedAt: null },
      { $set: { revokedAt: at, revocationReason: reason } },
      { session },
    );
  await db
    .collection("auth_challenges")
    .updateMany(
      { accountId, consumedAt: null },
      { $set: { consumedAt: at, revokedAt: at, revocationReason: reason } },
      { session },
    );
  await db
    .collection("contact_requests")
    .updateMany(
      { accountId },
      { $set: { revokedAt: at, revocationReason: reason, state: "cancelled" } },
      { session },
    );
  await db
    .collection("staff_recovery_requests")
    .updateMany(
      { accountId, revokedAt: null },
      { $set: { revokedAt: at, revocationReason: reason } },
      { session },
    );
}
