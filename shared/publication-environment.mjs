import { assertPublicationReviewStorage } from "./publication-review-guard.mjs";

export function assertPublicationStorage(
  db,
  client,
  demoMode,
  role,
  environment = { mode: "test" },
) {
  if (environment.mode === "test")
    return assertPublicationReviewStorage(db, client, demoMode);
  if (environment.mode !== "normal-local" || demoMode !== true)
    throw new Error("Explicit local publication configuration is required.");
  const options = client?.options ?? {},
    hosts = options.hosts ?? [];
  if (role === "staff") {
    if (
      db?.databaseName === "capstone_staff_dev" &&
      hosts.length === 1 &&
      hosts[0].host === "127.0.0.1" &&
      hosts[0].port === 27018 &&
      options.replicaSet === "capstoneStaffDev"
    )
      return;
  } else if (role === "public") {
    const target = environment.publicTarget;
    if (
      target?.database === "medical-center-dev" &&
      db?.databaseName === target.database &&
      typeof target.srvHost === "string" &&
      target.srvHost.endsWith(".mongodb.net") &&
      options.srvHost === target.srvHost &&
      options.tls === true &&
      !options.tlsInsecure &&
      !options.tlsAllowInvalidCertificates &&
      !options.tlsAllowInvalidHostnames
    )
      return;
  }
  throw new Error(
    "Publication storage does not match the approved isolated target.",
  );
}
