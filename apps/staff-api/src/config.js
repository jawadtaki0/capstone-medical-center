import { readAuthority } from "./local-security.js";

export const DATABASES = Object.freeze([
  "capstone_staff_dev",
  "capstone_staff_test",
]);
export function validateTarget({ host, port, database, replicaSet }) {
  if (
    host !== "127.0.0.1" ||
    port !== 27018 ||
    !DATABASES.includes(database) ||
    replicaSet !== "capstoneStaffDev"
  ) {
    throw new Error("Refusing a non-isolated staff database target.");
  }
}
export async function loadConfig({
  database = "capstone_staff_dev",
  demoMode = false,
} = {}) {
  const target = {
    host: "127.0.0.1",
    port: 27018,
    database,
    replicaSet: "capstoneStaffDev",
  };
  validateTarget(target);
  // No public environment file or fallback connection string is ever consulted.
  if (!demoMode)
    throw new Error(
      "Explicit --demo-loopback is required for this development authority.",
    );
  const authority = await readAuthority();
  const username =
    database === "capstone_staff_test" ? "staff_test" : "staff_app";
  const password =
    database === "capstone_staff_test"
      ? authority.testPassword
      : authority.appPassword;
  const uri = `mongodb://${username}:${encodeURIComponent(password)}@127.0.0.1:27018/${database}?authSource=${database}&replicaSet=capstoneStaffDev&directConnection=true`;
  return {
    ...target,
    uri,
    key: authority.key,
    apiHost: "127.0.0.1",
    apiPort: 4100,
    demoMode,
  };
}
