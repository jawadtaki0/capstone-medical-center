import express from "express";
import { patientPhoneVerification } from "./patient-phone-verification.js";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { canonicalPhone } from "../../staff/shared/contact-input.js";
import {
  childBirthDateAllowed,
  PATIENT_FIELDS,
  patientInput,
  patientToday,
} from "../../staff/shared/patient-input.js";
import {
  exact,
  RequestError,
} from "../../../shared/website-request-contract.mjs";

const derive = promisify(scrypt);
const work = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const randomToken = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linkLifetime = 30 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const usernamePattern = /^\p{L}[\p{L}\p{M}0-9_.-]{2,31}$/u;
const normalizeUsername = (value) =>
  value.trim().toLowerCase().normalize("NFC");
const usernameCollation = { locale: "en", strength: 2 };
const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

class AccountError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

function email(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !emailPattern.test(value.trim())
  )
    throw new AccountError("invalid_email");
  return value.trim().toLowerCase();
}

function alias(value) {
  if (typeof value !== "string" || value.length > 254)
    throw new AccountError("invalid_identifier");
  const text = normalizeUsername(value);
  if (text.includes("@")) return { email: email(text) };
  if (usernamePattern.test(text)) return { username: text };
  const phone = parsePhoneNumberFromString(text, {
    defaultCountry: "LB",
    extract: false,
  });
  if (phone?.isValid() && !phone.ext)
    return { verifiedPersonalPhone: phone.number };
  throw new AccountError("invalid_identifier");
}

function password(value, minimum = 1) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    Buffer.byteLength(value) > 128
  )
    throw new AccountError("invalid_password");
  return value;
}

const dto = (row) => ({
  email: row.email,
  username: row.username ?? null,
  verifiedPhone: row.verifiedPersonalPhone ?? null,
  bookingPhone: row.verifiedWhatsAppPhone ?? null,
  pendingPhone: row.pendingPhone ?? null,
  profiles: (row.profiles ?? []).map(
    ({ id, firstName, lastName, relationship }) => ({
      id,
      firstName,
      lastName,
      relationship,
    }),
  ),
});

export async function ensurePatientAccountIndexes(db) {
  const accounts = db.collection("patient_accounts");
  await accounts.createIndex({ email: 1 }, { unique: true });
  await accounts.createIndex(
    { username: 1 },
    {
      name: "username_case_insensitive",
      unique: true,
      sparse: true,
      collation: usernameCollation,
    },
  );
  await accounts.createIndex(
    { verifiedPersonalPhone: 1 },
    { unique: true, sparse: true },
  );
  await accounts.createIndex(
    { "phoneCheck.id": 1 },
    { unique: true, sparse: true },
  );
  await accounts.createIndex(
    { "recoveryPhone.id": 1 },
    { unique: true, sparse: true },
  );
  await accounts.createIndex({ "sessions.digest": 1 }, { sparse: true });
  await accounts.createIndex({ "recovery.digest": 1 }, { sparse: true });
  await accounts.createIndex({ "replacement.digest": 1 }, { sparse: true });
  for (const collection of [
    "patient_account_signups",
    "patient_account_limits",
  ])
    await db
      .collection(collection)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export function patientAccountRouter({
  db,
  client,
  publicOrigin,
  deliver,
  intake,
  phoneKey,
  sourceReader = (req) => req.ip,
  clock = () => new Date(),
}) {
  const origin = new URL(publicOrigin);
  const secure = origin.protocol === "https:";
  if (
    origin.origin !== publicOrigin ||
    (!secure &&
      (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"))
  )
    throw new Error(
      "A canonical HTTPS patient account origin is required outside loopback review.",
    );
  const cookieName = secure ? "__Host-cedar-patient" : "cedar-patient-review";
  const cookie = { httpOnly: true, secure, sameSite: "lax", path: "/" };
  const router = express.Router();
  const accounts = db.collection("patient_accounts");
  const signups = db.collection("patient_account_signups");
  const limits = db.collection("patient_account_limits");
  let passwordJobs = 0;

  async function hash(value, salt = randomBytes(16).toString("hex")) {
    if (passwordJobs >= 4) throw new AccountError("try_later", 503);
    passwordJobs++;
    try {
      const key = await derive(value, salt, 64, work);
      return salt + ":" + key.toString("hex");
    } finally {
      passwordJobs--;
    }
  }

  async function matches(value, stored) {
    const actual = await hash(
      password(value),
      stored?.split(":")[0] ?? "cedar-patient-dummy",
    );
    return (
      !!stored && timingSafeEqual(Buffer.from(actual), Buffer.from(stored))
    );
  }

  async function budget(key, count, windowMs) {
    const bucket = Math.floor(+clock() / windowMs);
    const id = digest(JSON.stringify([key, windowMs, bucket]));
    const update = {
      $inc: { uses: 1 },
      $setOnInsert: { expiresAt: new Date((bucket + 1) * windowMs) },
    };
    let row;
    try {
      row = await limits.findOneAndUpdate({ _id: id }, update, {
        upsert: true,
        returnDocument: "after",
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      row = await limits.findOneAndUpdate({ _id: id }, update, {
        returnDocument: "after",
      });
    }
    if (!row || row.uses > count) throw new AccountError("try_later", 429);
  }

  function challenge() {
    const token = randomToken();
    return {
      token,
      record: {
        digest: digest(token),
        expiresAt: new Date(+clock() + linkLifetime),
      },
    };
  }

  function readToken(value) {
    if (typeof value !== "string" || !tokenPattern.test(value))
      throw new AccountError("invalid_link");
    return digest(value);
  }

  function send(to, purpose, token, language) {
    const link = new URL("/account", publicOrigin);
    if (language === "ar") link.searchParams.set("lang", "ar");
    link.hash = new URLSearchParams({ action: purpose, token }).toString();
    return deliver({
      to,
      purpose,
      link: link.href,
      language: language === "ar" ? "ar" : "en",
    });
  }

  function sessionQuery(req) {
    const value = req.headers.cookie
      ?.split(/;\s*/)
      .find((item) => item.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    return value && tokenPattern.test(value)
      ? {
          sessions: {
            $elemMatch: { digest: digest(value), expiresAt: { $gt: clock() } },
          },
        }
      : null;
  }

  async function current(req) {
    const session = sessionQuery(req);
    const row = session && (await accounts.findOne(session));
    if (!row) throw new AccountError("sign_in_required", 401);
    return { row, guard: { _id: row._id, revision: row.revision, ...session } };
  }

  async function change(filter, update) {
    const result = await accounts.updateOne(filter, update);
    if (!result.matchedCount) throw new AccountError("try_again", 409);
  }
  const phoneVerification =
    phoneKey &&
    patientPhoneVerification({
      accounts,
      key: phoneKey,
      clock,
      publicOrigin,
      change,
      ErrorType: AccountError,
    });
  router.phoneVerification = phoneVerification;
  const phone = () => {
    if (!phoneVerification) throw new AccountError("try_later", 503);
    return phoneVerification;
  };
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    if (
      req.method === "POST" &&
      (req.get("Origin") !== publicOrigin || !req.is("application/json"))
    )
      return res.status(403).json({ error: "invalid_origin" });
    next();
  });
  router.use(express.json({ limit: "4kb" }));

  function post(path, handler) {
    router.post(path, async (req, res) => {
      await budget(["source", sourceReader(req)], 60, 15 * 60_000);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new AccountError("invalid_input");
      res.json(await handler(body, req, res));
    });
  }

  post("/phone-request", async (body, req) => {
    const { row, guard } = await current(req);
    await budget(["phone-request", row._id], 6, 60 * 60_000);
    return phone().request(row, guard, body);
  });
  post("/phone-status", async (body, req) => {
    exact(body, []);
    const { row } = await current(req);
    return { state: phone().status(row, clock()) };
  });
  post("/phone-verify", async (body, req) => {
    const { row, guard } = await current(req);
    await budget(["phone-verify", row._id], 15, 60 * 60_000);
    await phone().verify(row, guard, body);
    return { account: dto(await accounts.findOne({ _id: row._id })) };
  });
  post("/phone-recover", async (body) => {
    exact(body, ["phone", "language"]);
    const number = canonicalPhone(body.phone);
    if (!number) throw new AccountError("invalid_account_phone");
    await budget(["phone-recover", number], 5, 60 * 60_000);
    const row = await accounts.findOne({ verifiedPersonalPhone: number });
    if (row)
      await phone().requestRecovery(row, body.language === "ar" ? "ar" : "en");
    return { ok: true };
  });
  post("/phone-reset", async (body) => {
    exact(body, ["phone", "code", "password"]);
    const number = canonicalPhone(body.phone);
    if (!number || typeof body.code !== "string" || !/^\d{6}$/.test(body.code))
      throw new AccountError("invalid_phone_code");
    await budget(["phone-reset", number], 12, 60 * 60_000);
    const row = await accounts.findOne({ verifiedPersonalPhone: number });
    await phone().recover(
      row,
      body.code,
      await hash(password(body.password, 12)),
    );
    return { ok: true };
  });

  router.get("/session", async (req, res) => {
    const filter = sessionQuery(req);
    const row = filter && (await accounts.findOne(filter));
    res.json({ account: row ? dto(row) : null });
  });

  function ownedProfile(row, id) {
    const profile = (row.profiles ?? []).find((item) => item.id === id);
    if (!profile) throw new AccountError("profile_unavailable", 404);
    return profile;
  }

  post("/add-profiles", async (body, req) => {
    const { row, guard } = await current(req);
    exact(body, ["profiles"]);
    const inputs = body.profiles;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2)
      throw new AccountError("invalid_patient");
    const roles = inputs.map((input) => input?.relationship);
    if (
      new Set(roles).size !== inputs.length ||
      roles.some((role) => !["self", "child"].includes(role))
    )
      throw new AccountError("invalid_relationship");
    if (
      roles.includes("self") &&
      row.profiles?.some((profile) => profile.relationship === "self")
    )
      throw new AccountError("self_profile_exists", 409);
    const phone = row.verifiedWhatsAppPhone ?? row.pendingPhone;
    if (!phone) throw new AccountError("phone_verification_required", 403);
    const today = patientToday(clock());
    const profiles = inputs.map(({ relationship, patient }) => {
      const { record, errors } = patientInput({ ...patient, phone }, today);
      if (Object.keys(errors).length) throw new AccountError("invalid_patient");
      if (
        relationship === "child" &&
        !childBirthDateAllowed(record.dateOfBirth, today)
      )
        throw new AccountError("invalid_child_birth_date");
      return { ...record, id: randomUUID(), relationship };
    });
    await change(guard, {
      $push: { profiles: { $each: profiles } },
      $inc: { revision: 1 },
    });
    return {
      account: dto({
        ...row,
        profiles: [...(row.profiles ?? []), ...profiles],
      }),
    };
  });

  post("/profile-requests", async (body, req) => {
    exact(body, ["profileId"]);
    const { row } = await current(req);
    const profile = ownedProfile(row, body.profileId);
    if (!intake) throw new AccountError("try_later", 503);
    return {
      requests: await intake.profileRequests({
        accountId: row._id,
        profileId: profile.id,
      }),
    };
  });

  post("/book", async (body, req) => {
    exact(body, [
      "profileId",
      "selection",
      "submissionKey",
      "language",
      "honeypot",
    ]);
    const { row } = await current(req);
    const profile = ownedProfile(row, body.profileId);
    if (!row.verifiedWhatsAppPhone)
      throw new AccountError("phone_verification_required", 403);
    if (!intake) throw new AccountError("try_later", 503);
    const patient = Object.fromEntries(
      PATIENT_FIELDS.map((field) => [field, profile[field]]),
    );
    const { profileId, language, ...input } = body;
    return intake.submit(
      {
        ...input,
        patient: {
          ...patient,
          phone: row.verifiedWhatsAppPhone,
          preferredLanguage: language,
        },
      },
      sourceReader(req),
      { accountId: row._id, profileId },
    );
  });

  post("/signup", async (body) => {
    const to = email(body.email);
    if (!["self", "child"].includes(body.relationship))
      throw new AccountError("invalid_relationship");
    const child = body.relationship === "child";
    const pendingPhone = canonicalPhone(
      child ? body.phone : body.patient?.phone,
    );
    if (!pendingPhone) throw new AccountError("invalid_account_phone");
    const today = patientToday(clock());
    const { record, errors } = patientInput(
      { ...body.patient, phone: pendingPhone },
      today,
    );
    if (Object.keys(errors).length) throw new AccountError("invalid_patient");
    if (child && !childBirthDateAllowed(record.dateOfBirth, today))
      throw new AccountError("invalid_child_birth_date");
    await budget(["mail", to], 5, 60 * 60_000);
    if (!(await accounts.findOne({ email: to }, { projection: { _id: 1 } }))) {
      const { token, record: link } = challenge();
      await signups.insertOne({
        _id: link.digest,
        expiresAt: link.expiresAt,
        email: to,
        pendingPhone,
        profile: { ...record, relationship: body.relationship },
      });
      await send(to, "activate", token, body.language);
    }
    return { ok: true };
  });

  post("/activate", async (body) => {
    const key = readToken(body.token);
    if (!(await signups.findOne({ _id: key, expiresAt: { $gt: clock() } })))
      throw new AccountError("invalid_link");
    const username =
      typeof body.username === "string" ? normalizeUsername(body.username) : "";
    if (!usernamePattern.test(username))
      throw new AccountError("invalid_username");
    const passwordHash = await hash(password(body.password, 12));
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const signup = await signups.findOneAndDelete(
          { _id: key, expiresAt: { $gt: clock() } },
          { session },
        );
        if (!signup) throw new AccountError("invalid_link");
        await accounts.insertOne(
          {
            email: signup.email,
            username,
            ...(signup.pendingPhone
              ? { pendingPhone: signup.pendingPhone }
              : {}),
            ...(signup.profile
              ? { profiles: [{ ...signup.profile, id: randomUUID() }] }
              : {}),
            _id: randomUUID(),
            passwordHash,
            revision: 0,
            emailVerifiedAt: clock(),
            sessions: [],
          },
          { session },
        );
        await signups.deleteMany({ email: signup.email }, { session });
      });
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.username)
        throw new AccountError("username_taken", 409);
      throw error;
    } finally {
      await session.endSession();
    }
    return { ok: true };
  });

  post("/signin", async (body, _req, res) => {
    const identifier = alias(body.identifier);
    await budget(["signin", identifier], 12, 15 * 60_000);
    const row = await accounts.findOne(
      identifier,
      identifier.username ? { collation: usernameCollation } : {},
    );
    if (!(await matches(body.password, row?.passwordHash)))
      throw new AccountError("invalid_signin", 401);
    const token = randomToken();
    await change(
      { _id: row._id, revision: row.revision },
      {
        $push: {
          sessions: {
            $each: [
              {
                digest: digest(token),
                expiresAt: new Date(+clock() + sessionLifetime),
              },
            ],
            $slice: -10,
          },
        },
      },
    );
    res.cookie(cookieName, token, { ...cookie, maxAge: sessionLifetime });
    return { account: dto(row) };
  });

  post("/username-suggestions", async (body) => {
    const key = readToken(body.token);
    const signup = await signups.findOne({
      _id: key,
      expiresAt: { $gt: clock() },
    });
    if (!signup) throw new AccountError("invalid_link");
    const name = (value) =>
      Array.from(normalizeUsername(value).replace(/[^\p{L}\p{M}]+/gu, ""))
        .slice(0, 13)
        .join("");
    const base = signup.profile
      ? [name(signup.profile.firstName), name(signup.profile.lastName)].join(
          ".",
        )
      : "cedar";
    return {
      suggestions: Array.from(
        { length: 3 },
        (_, index) =>
          base +
          (body.refresh || index || !signup.profile
            ? "-" + randomBytes(2).toString("hex")
            : ""),
      ),
    };
  });

  post("/recover", async (body) => {
    const to = email(body.email);
    await budget(["mail", to], 5, 60 * 60_000);
    const row = await accounts.findOne({ email: to });
    if (row) {
      const { token, record } = challenge();
      await change(
        { _id: row._id, revision: row.revision },
        { $set: { recovery: record } },
      );
      await send(to, "reset", token, body.language);
    }
    return { ok: true };
  });

  post("/reset", async (body) => {
    const key = readToken(body.token);
    const filter = () => ({
      "recovery.digest": key,
      "recovery.expiresAt": { $gt: clock() },
    });
    const row = await accounts.findOne(filter());
    if (!row) throw new AccountError("invalid_link");
    const passwordHash = await hash(password(body.password, 12));
    await change(
      { _id: row._id, revision: row.revision, ...filter() },
      {
        $set: { passwordHash, sessions: [] },
        $unset: { recovery: "", recoveryPhone: "", replacement: "" },
        $inc: { revision: 1 },
      },
    );
    return { ok: true };
  });

  post("/replace-email", async (body, req) => {
    const { row, guard } = await current(req);
    const to = email(body.email);
    await budget(["reauth", row._id], 12, 15 * 60_000);
    if (!(await matches(body.password, row.passwordHash)))
      throw new AccountError("incorrect_password", 401);
    if (to === row.email) throw new AccountError("same_email");
    await budget(["mail", to], 5, 60 * 60_000);
    const { token, record } = challenge();
    await change(guard, { $set: { replacement: { ...record, email: to } } });
    await send(to, "verify-email", token, body.language);
    return { ok: true };
  });

  post("/verify-email", async (body) => {
    const key = readToken(body.token);
    const filter = {
      "replacement.digest": key,
      "replacement.expiresAt": { $gt: clock() },
    };
    const row = await accounts.findOne(filter);
    if (!row) throw new AccountError("invalid_link");
    await change(
      { _id: row._id, revision: row.revision, ...filter },
      {
        $set: { email: row.replacement.email, emailVerifiedAt: clock() },
        $unset: { replacement: "", recovery: "" },
        $inc: { revision: 1 },
      },
    );
    return { ok: true };
  });

  post("/signout", async (_body, req, res) => {
    const filter = sessionQuery(req);
    if (filter)
      await accounts.updateOne(filter, {
        $pull: { sessions: { digest: filter.sessions.$elemMatch.digest } },
      });
    res.clearCookie(cookieName, cookie);
    return { ok: true };
  });

  post("/delete", async (body, req, res) => {
    const { row, guard } = await current(req);
    await budget(["reauth", row._id], 12, 15 * 60_000);
    if (!(await matches(body.password, row.passwordHash)))
      throw new AccountError("incorrect_password", 401);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await accounts.deleteOne(guard, { session });
        if (!result.deletedCount) throw new AccountError("try_again", 409);
        await signups.deleteMany({ email: row.email }, { session });
      });
    } finally {
      await session.endSession();
    }
    res.clearCookie(cookieName, cookie);
    return { ok: true };
  });

  router.use((error, _req, res, _next) => {
    if (error instanceof RequestError)
      return res
        .status(error.status)
        .json({ error: error.code, message: error.message });
    if (error instanceof AccountError)
      return res.status(error.status).json({ error: error.message });
    if (error.code === 11000)
      return res.status(409).json({ error: "identifier_unavailable" });
    if (error.status === 400 || error.status === 413)
      return res.status(error.status).json({ error: "invalid_input" });
    res.status(503).json({ error: "try_later" });
  });
  return router;
}
