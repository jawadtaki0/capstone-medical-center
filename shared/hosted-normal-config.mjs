import { createHash } from "node:crypto";

function origin(value, suffix) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw Error("Invalid hosted capstone origin.");
  }
  if (
    u.protocol !== "https:" ||
    u.origin !== value ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.endsWith(suffix) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      u.hostname.slice(0, -suffix.length),
    )
  )
    throw Error("Invalid hosted capstone origin.");
}

export function validateHostedNormalConfig(c) {
  if (
    c?.mode !== "normal-hosted" ||
    c.publicDatabase !== "medical-center-dev" ||
    c.capstoneDemo !== true ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+mongodb\.net$/.test(
      c.publicSrvHost ?? "",
    ) ||
    !/^stream:[a-f0-9-]{36}$/.test(c.streamId ?? "")
  )
    throw Error("Explicit normal hosted capstone configuration required.");
  origin(c.apiOrigin, ".onrender.com");
  origin(c.publicBase, ".vercel.app");
  return c;
}

export function hostedNormalIdentity(c) {
  validateHostedNormalConfig(c);
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: c.mode,
        publicDatabase: c.publicDatabase,
        publicSrvHost: c.publicSrvHost,
        streamId: c.streamId,
        apiOrigin: c.apiOrigin,
        publicBase: c.publicBase,
        capstoneDemo: true,
      }),
    )
    .digest("hex");
}
