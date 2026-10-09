import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import argon2 from "argon2";
import { generate, generateSecret } from "otplib";
import { createApp } from "../../src/app.js";
import { connectStaffDatabase } from "../../src/db.js";
import { createVault } from "../../src/local-security.js";

export const TEST_DATABASE = "capstone_staff_test";
export const STAFF_COLLECTIONS = Object.freeze([
  "installation_state",
  "accounts",
  "staff_profiles",
  "auth_challenges",
  "staff_sessions",
  "auth_throttles",
  "security_events",
  "account_setup_codes",
  "staff_management_state",
  "contact_requests",
  "contact_counters",
  "contact_delivery_budgets",
]);

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertIsolatedTestTarget({ db, config, client }) {
  const hosts = client?.options?.hosts ?? [];
  if (
    db?.databaseName !== TEST_DATABASE ||
    config?.database !== TEST_DATABASE ||
    config.host !== "127.0.0.1" ||
    config.port !== 27018 ||
    config.replicaSet !== "capstoneStaffDev" ||
    hosts.length !== 1 ||
    hosts[0].host !== "127.0.0.1" ||
    hosts[0].port !== 27018
  ) {
    throw new Error(
      "Security fixtures may access only the isolated loopback staff-test database.",
    );
  }
}

export function syntheticProfile(overrides = {}) {
  return {
    firstName: "Synthetic",
    lastName: "Staff",
    fatherName: "Synthetic Father",
    motherName: "Synthetic Mother",
    dateOfBirth: "1990-01-15",
    address: "Synthetic local test address",
    phone: "+96171123456",
    email: `synthetic-${randomUUID()}@example.invalid`,
    departments: ["Administration"],
    employmentStartDate: "2026-10-02",
    qualification: {
      type: "university",
      title: "Synthetic relevant degree",
      institution: "Synthetic institution",
    },
    ...overrides,
  };
}

export function syntheticPassword() {
  return `Synthetic only ${randomBytes(24).toString("base64url")}`;
}

export async function createSecurityFixture({ contactDelivery } = {}) {
  let connection = await connectStaffDatabase({
    database: TEST_DATABASE,
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
  let vault = createVault(connection.config.key);
  let server;
  let origin;
  let failAuditWrites = false;
  // Start each test at the current TOTP boundary. Advance only this fake clock
  // so expiry is enforced by the API while Mongo's real-time TTL stays behind.
  let milliseconds = Math.floor(Date.now() / 30000) * 30000;
  const clock = () => new Date(milliseconds);

  async function stopHttp() {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async function startHttp() {
    const dbForApp = failAuditWrites
      ? {
          databaseName: connection.db.databaseName,
          command: (...args) => connection.db.command(...args),
          collection(name) {
            const target = connection.db.collection(name);
            if (name !== "security_events") return target;
            return new Proxy(target, {
              get(collection, property) {
                if (property === "insertOne")
                  return async () => {
                    throw new Error("Synthetic audit write failure");
                  };
                const value = Reflect.get(collection, property);
                return typeof value === "function"
                  ? value.bind(collection)
                  : value;
              },
            });
          },
        }
      : connection.db;
    server = createApp({
      db: dbForApp,
      client: connection.client,
      vault,
      clock,
      demoMode: true,
      contactDelivery,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
  }

  return {
    get db() {
      return connection.db;
    },
    get vault() {
      return vault;
    },
    clock,
    advance(millisecondsToAdd) {
      milliseconds += millisecondsToAdd;
    },
    async reset() {
      await stopHttp();
      assertIsolatedTestTarget(connection); // Rechecked immediately before cleanup.
      for (const name of STAFF_COLLECTIONS)
        await connection.db.collection(name).deleteMany({});
      await connection.db
        .collection("staff_management_state")
        .insertOne({ _id: "staff-controls", revision: 0, createdAt: clock() });
      milliseconds = Math.floor(Date.now() / 30000) * 30000;
      failAuditWrites = false;
      await startHttp();
    },
    async restart({ reconnect = false, failAudit = false } = {}) {
      await stopHttp();
      failAuditWrites = failAudit;
      if (reconnect) {
        await connection.client.close();
        vault.destroy();
        connection = await connectStaffDatabase({
          database: TEST_DATABASE,
          demoMode: true,
        });
        assertIsolatedTestTarget(connection);
        vault = createVault(connection.config.key);
      }
      await startHttp();
    },
    async close() {
      await stopHttp();
      await connection.client.close();
      vault.destroy();
    },
    async request(
      path,
      {
        method = "GET",
        body,
        token,
        originHeader = "app://staff",
        headers = {},
      } = {},
    ) {
      const requestHeaders = { Origin: originHeader, ...headers };
      if (body !== undefined && !Object.hasOwn(requestHeaders, "Content-Type"))
        requestHeaders["Content-Type"] = "application/json";
      if (token) requestHeaders.Authorization = `Bearer ${token}`;
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    },
    async issueSetup({ expiresIn = 30 * 60 * 1000 } = {}) {
      const code = randomBytes(32).toString("base64url");
      await connection.db.collection("installation_state").insertOne({
        _id: "first-admin",
        status: "issued",
        codeHash: digest(code),
        issuedAt: clock(),
        expiresAt: new Date(milliseconds + expiresIn),
        attempts: 0,
      });
      return code;
    },
    async account({
      roles = ["Clinic Receptionist"],
      status = "active",
      username,
      mfa = false,
      departments = ["Clinic"],
      backupAcknowledged = true,
      version = 1,
    } = {}) {
      // These records exist solely behind the test-target guard; there is no
      // fixture HTTP endpoint, fixed production user, or default password.
      const id = `synthetic:${randomUUID()}`;
      const assignedUsername =
        username ?? `synthetic.${randomBytes(6).toString("hex")}`;
      const password = syntheticPassword();
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const secret = mfa ? generateSecret() : null;
      const backupCodes = mfa
        ? Array.from({ length: 10 }, () => randomBytes(16).toString("hex"))
        : [];
      const account = {
        _id: id,
        username: assignedUsername,
        roles,
        status,
        version,
        passwordHash,
        createdAt: clock(),
        mfa: {
          enabled: mfa,
          version: 1,
          backupAcknowledged,
          ...(mfa
            ? {
                secretCipher: vault.encrypt(secret),
                lastAcceptedStep: Math.floor(milliseconds / 30000) - 2,
              }
            : {}),
          backupCodes: backupCodes.map((code) => ({
            digest: digest(code),
            usedAt: null,
          })),
        },
      };
      await connection.db.collection("accounts").insertOne(account);
      await connection.db.collection("staff_profiles").insertOne({
        _id: `synthetic-profile:${randomUUID()}`,
        accountId: id,
        ...syntheticProfile({ departments }),
        emailVerified: false,
      });
      return { id, username: assignedUsername, password, secret, backupCodes };
    },
    async totp(secret, offset = 0) {
      return generate({
        secret,
        epoch: Math.floor((milliseconds + offset) / 1000),
        period: 30,
        digits: 6,
      });
    },
  };
}
