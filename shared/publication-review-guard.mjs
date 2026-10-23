// This increment deliberately has no live/Atlas storage configuration.
export function assertPublicationReviewStorage(db, client, demoMode) {
  const hosts = client?.options?.hosts ?? [];
  if (
    demoMode !== true ||
    db?.databaseName !== "capstone_staff_test" ||
    hosts.length !== 1 ||
    hosts[0].host !== "127.0.0.1" ||
    hosts[0].port !== 27018 ||
    client.options.replicaSet !== "capstoneStaffDev"
  )
    throw new Error(
      "Publication delivery requires the explicit isolated loopback TEST setup.",
    );
}
