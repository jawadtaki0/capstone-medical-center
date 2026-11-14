import { createHmac, randomUUID } from "node:crypto";
import { exact } from "../../../shared/website-request-contract.mjs";

const lifetime = 15 * 60_000;
const attempts = 5;

export function patientPhoneVerification({
  accounts,
  key,
  clock,
  publicOrigin,
  change,
  ErrorType,
}) {
  const fail = (code, status = 400) => new ErrorType(code, status);
  const codeFor = (row) =>
    String(
      createHmac("sha256", key)
        .update(JSON.stringify([row._id, row.pendingPhone, row.phoneCheck.id]))
        .digest()
        .readUInt32BE() % 1_000_000,
    ).padStart(6, "0");
  const status = (row, at) => {
    const check = row.phoneCheck;
    if (!check) return null;
    if (["verified", "used"].includes(check.state)) return check.state;
    if (
      check.expiresAt &&
      (check.expiresAt <= at || check.attempts >= attempts)
    )
      return "expired";
    return check.state;
  };
  const summary = (row, at) => ({
    id: row.phoneCheck.id,
    phone: row.pendingPhone,
    account: row.username ?? row.email,
    requestedAt: row.phoneCheck.requestedAt,
    state: status(row, at),
    expiresAt: row.phoneCheck.expiresAt ?? null,
  });
  return {
    async requestRecovery(row, language) {
      const at = clock();
      if (
        row.recoveryPhone &&
        status({ phoneCheck: row.recoveryPhone }, at) !== "expired" &&
        row.recoveryPhone.state !== "used"
      )
        return;
      await change(
        { _id: row._id, revision: row.revision },
        {
          $set: {
            recoveryPhone: {
              id: randomUUID(),
              state: "queued",
              requestedAt: at,
              attempts: 0,
              language,
            },
          },
          $inc: { revision: 1 },
        },
      );
    },
    async recover(row, code, passwordHash) {
      const check = row?.recoveryPhone;
      const at = clock();
      const subject = {
        ...row,
        pendingPhone: row?.verifiedPersonalPhone,
        phoneCheck: check,
      };
      if (!["opened", "sent"].includes(status(subject, at)))
        throw fail("invalid_phone_code");
      const filter = {
        _id: row._id,
        revision: row.revision,
        "recoveryPhone.id": check.id,
        "recoveryPhone.expiresAt": { $gt: at },
      };
      if (code !== codeFor(subject)) {
        await change(filter, {
          $inc: { "recoveryPhone.attempts": 1, revision: 1 },
        });
        throw fail("invalid_phone_code");
      }
      await change(filter, {
        $set: { passwordHash, sessions: [], "recoveryPhone.state": "used" },
        $unset: { recovery: "", replacement: "" },
        $inc: { revision: 1 },
      });
    },
    async request(row, guard, body) {
      exact(body, ["personal", "language"]);
      if (
        typeof body.personal !== "boolean" ||
        !["en", "ar"].includes(body.language)
      )
        throw fail("invalid_input");
      if (!row.pendingPhone) throw fail("invalid_account_phone");
      if (row.verifiedWhatsAppPhone) throw fail("phone_already_verified", 409);
      const at = clock();
      if (row.phoneCheck && status(row, at) !== "expired")
        return { state: status(row, at) };
      const check = {
        id: randomUUID(),
        state: "queued",
        requestedAt: at,
        attempts: 0,
        personal: body.personal,
        language: body.language,
      };
      await change(guard, {
        $set: { phoneCheck: check },
        $inc: { revision: 1 },
      });
      return { state: "queued" };
    },
    async verify(row, guard, body) {
      exact(body, ["code"]);
      if (!/^\d{6}$/.test(typeof body.code === "string" ? body.code : ""))
        throw fail("invalid_phone_code");
      const at = clock();
      if (!["opened", "sent"].includes(status(row, at)))
        throw fail("phone_code_unavailable", 409);
      const filter = {
        ...guard,
        "phoneCheck.id": row.phoneCheck.id,
        "phoneCheck.expiresAt": { $gt: at },
      };
      if (body.code !== codeFor(row)) {
        await change(filter, {
          $inc: { "phoneCheck.attempts": 1, revision: 1 },
        });
        throw fail("invalid_phone_code");
      }
      const set = {
        verifiedWhatsAppPhone: row.pendingPhone,
        "phoneCheck.state": "verified",
      };
      const update = (values) =>
        change(filter, { $set: values, $inc: { revision: 1 } });
      try {
        await update(
          row.phoneCheck.personal
            ? { ...set, verifiedPersonalPhone: row.pendingPhone }
            : set,
        );
      } catch (error) {
        if (error.code !== 11000 || !error.keyPattern?.verifiedPersonalPhone)
          throw error;
        await update(set);
      }
      return { ok: true };
    },
    async staff(body) {
      const at = clock();
      if (body.action === "list") {
        exact(body, ["action"]);
        const lists = await Promise.all(
          ["phoneCheck", "recoveryPhone"].map(async (field) => {
            const activeFilter = {
              [field + ".state"]: { $in: ["queued", "prepared", "opened"] },
              $or: [
                { [field + ".state"]: "queued" },
                {
                  [field + ".expiresAt"]: { $gt: at },
                  [field + ".attempts"]: { $lt: attempts },
                },
              ],
            };
            const [count, active, history] = await Promise.all([
              accounts.countDocuments(activeFilter),
              accounts
                .find(activeFilter)
                .sort({ [field + ".requestedAt"]: 1 })
                .limit(50)
                .toArray(),
              accounts
                .find({
                  [field + ".id"]: { $exists: true },
                  $nor: [activeFilter],
                })
                .sort({ [field + ".requestedAt"]: -1 })
                .limit(50)
                .toArray(),
            ]);
            const format = (row) =>
              field === "phoneCheck"
                ? summary(row, at)
                : {
                    ...summary(
                      {
                        ...row,
                        phoneCheck: row.recoveryPhone,
                        pendingPhone: row.verifiedPersonalPhone,
                      },
                      at,
                    ),
                    recovery: true,
                  };
            return {
              count,
              active: active.map(format),
              history: history.map(format),
            };
          }),
        );
        return {
          count: lists[0].count + lists[1].count,
          rows: [
            ...lists.flatMap((list) => list.active),
            ...lists.flatMap((list) => list.history),
          ],
        };
      }
      exact(body, ["action", "id"]);
      if (typeof body.id !== "string") throw fail("invalid_input");
      const account = await accounts.findOne({
        $or: [{ "phoneCheck.id": body.id }, { "recoveryPhone.id": body.id }],
      });
      if (!account) throw fail("phone_code_unavailable", 404);
      const recovery = account.recoveryPhone?.id === body.id;
      const field = recovery ? "recoveryPhone" : "phoneCheck";
      const row = recovery
        ? {
            ...account,
            phoneCheck: account.recoveryPhone,
            pendingPhone: account.verifiedPersonalPhone,
          }
        : account;
      const state = status(row, at);
      const filter = {
        _id: row._id,
        revision: row.revision,
        [field + ".id"]: body.id,
      };
      if (
        body.action === "prepare" &&
        ["queued", "prepared", "opened"].includes(state)
      ) {
        const expiresAt = row.phoneCheck.expiresAt ?? new Date(+at + lifetime);
        if (state === "queued")
          await change(filter, {
            $set: {
              [field + ".state"]: "prepared",
              [field + ".expiresAt"]: expiresAt,
            },
            $inc: { revision: 1 },
          });
        const ar = row.phoneCheck.language === "ar";
        const link = new URL(
          `/account?view=${recovery ? "phone-reset" : "verify-phone"}` +
            (ar ? "&lang=ar" : ""),
          publicOrigin,
        );
        return {
          phone: row.pendingPhone,
          expiresAt,
          message: ar
            ? `رمز التحقق من سيدر: ${codeFor(row)}\nتابع: ${link.href}`
            : `Cedar verification code: ${codeFor(row)}\nContinue: ${link.href}`,
        };
      }
      if (
        (body.action === "opened" && state === "opened") ||
        (body.action === "sent" && state === "sent")
      )
        return { ok: true };
      if (
        (body.action === "opened" && state === "prepared") ||
        (body.action === "sent" && state === "opened")
      ) {
        await change(filter, {
          $set: { [field + ".state"]: body.action },
          $inc: { revision: 1 },
        });
        return { ok: true };
      }
      throw fail("phone_code_unavailable", 409);
    },
    status,
  };
}
