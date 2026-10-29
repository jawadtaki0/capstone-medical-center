import { createHash } from "node:crypto";

const refused = () =>
  new Error("Explicit isolated hosted-review configuration is required.");
function origin(value, suffix) {
  if (typeof value !== "string" || value.length > 253) throw refused();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw refused();
  }
  const label = url.hostname.slice(0, -suffix.length);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !url.hostname.endsWith(suffix) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )
    throw refused();
  return value;
}

// This contract deliberately cannot identify the normal databases or a local
// staff database. Private cloud credentials are loaded only by the server.
export function validateHostedReviewConfig(value) {
  if (
    !value ||
    value.mode !== "hosted-review" ||
    value.publicDatabase !== "capstone_public_review" ||
    typeof value.publicSrvHost !== "string" ||
    value.publicSrvHost.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+mongodb\.net$/.test(
      value.publicSrvHost,
    ) ||
    !/^stream:[a-f0-9-]{36}$/.test(value.streamId)
  )
    throw refused();
  origin(value.apiOrigin, ".onrender.com");
  origin(value.publicBase, ".vercel.app");
  return value;
}

export function hostedReviewIdentity(value) {
  validateHostedReviewConfig(value);
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: value.mode,
        apiOrigin: value.apiOrigin,
        publicBase: value.publicBase,
        publicDatabase: value.publicDatabase,
        publicSrvHost: value.publicSrvHost,
        streamId: value.streamId,
      }),
    )
    .digest("hex");
}
