import { assertPublicationReviewStorage } from "./publication-review-guard.mjs";
import { validateHostedReviewConfig } from "./hosted-review-config.mjs";

export function assertPublicationStorage(
  db,
  client,
  demoMode,
  role,
  environment = { mode: "test" },
) {
  if (environment.mode === "test")
    return assertPublicationReviewStorage(db, client, demoMode);
  if (environment.mode === "hosted-review") {
    validateHostedReviewConfig(environment);
    if (role === "staff")
      return assertPublicationReviewStorage(db, client, demoMode);
    const options = client?.options ?? {};
    if (
      role === "public" &&
      db?.databaseName === environment.publicDatabase &&
      options.srvHost === environment.publicSrvHost &&
      options.tls === true &&
      !options.tlsInsecure &&
      !options.tlsAllowInvalidCertificates &&
      !options.tlsAllowInvalidHostnames
    )
      return;
    throw new Error(
      "Hosted review storage does not match its explicitly configured isolated target.",
    );
  }
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
