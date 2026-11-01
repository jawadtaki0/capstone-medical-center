import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export async function prepareNormalHosting({
  apiOrigin,
  publicBase,
  confirmed = false,
} = {}) {
  if (!confirmed || process.cwd() !== root)
    throw Error("Explicit normal hosting preparation required.");
  const selected = JSON.parse(
    await readFile(join(root, ".local/cedar-staff-launcher.json"), "utf8"),
  );
  if (selected.version !== 1 || selected.demoMode !== true)
    throw Error("Existing selected runtime required.");
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = await (
    await import("node:fs/promises")
  ).realpath(selected.runtimeDirectory);
  const { dpapi, protectDirectory } = await import("../src/local-security.js");
  const { loadPublicationConfig } =
    await import("../src/publication-config.js");
  const { validateNormalConnection } =
    await import("../src/hosted-normal-config.js");
  const { loadHostedNormalEnvironment } =
    await import("../../api/src/hosted-normal.js");
  const { hostedNormalIdentity } =
    await import("../../../shared/hosted-normal-config.mjs");
  const directory = join(root, ".local/normal-hosting/private"),
    connectionFile = join(directory, "connection.dpapi"),
    providerFile = join(directory, "provider-env.dpapi");
  try {
    await access(connectionFile);
    throw Error(
      "Prepared configuration already exists; reconcile rather than replacing secrets.",
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let plain;
  try {
    const publication = await loadPublicationConfig();
    if (publication?.mode !== "normal-local")
      throw Error("Existing normal publication authority required.");
    plain = await dpapi(
      await readFile(join(directory, "atlas-normal.dpapi")),
      "Unprotect",
    );
    const credential = JSON.parse(plain.toString());
    plain.fill(0);
    plain = undefined;
    if (
      credential.version !== 1 ||
      credential.username !== "cedar_public_capstone" ||
      credential.database !== "medical-center-dev" ||
      typeof credential.password !== "string" ||
      !credential.password
    )
      throw Error("Dedicated normal Atlas credential required.");
    const c = validateNormalConnection({
      version: 1,
      mode: "normal-hosted",
      capstoneDemo: true,
      apiOrigin,
      publicBase,
      publicDatabase: publication.publicDatabase,
      publicSrvHost: publication.publicSrvHost,
      streamId: publication.streamId,
      importDigest: publication.importDigest,
      token: publication.token,
      credential: randomBytes(32).toString("base64url"),
      key: randomBytes(32).toString("base64url"),
      contact: "Capstone demonstration contact — not for medical care",
    });
    const env = {
      NODE_VERSION: "24.22.1",
      CEDAR_NORMAL_CAPSTONE_DEMO: "true",
      CEDAR_NORMAL_TRUSTED_PROXY: "render-cloudflare-client",
      CEDAR_NORMAL_API_ORIGIN: apiOrigin,
      CEDAR_NORMAL_PUBLIC_ORIGIN: publicBase,
      CEDAR_NORMAL_DATABASE: c.publicDatabase,
      CEDAR_NORMAL_ATLAS_SRV_HOST: c.publicSrvHost,
      CEDAR_NORMAL_STREAM_ID: c.streamId,
      CEDAR_NORMAL_PUBLICATION_TOKEN: c.token,
      CEDAR_NORMAL_REQUEST_CREDENTIAL: c.credential,
      CEDAR_NORMAL_REQUEST_KEY: c.key,
      CEDAR_NORMAL_CENTER_CONTACT: c.contact,
      CEDAR_NORMAL_MONGODB_URI: `mongodb+srv://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@${c.publicSrvHost}/medical-center-dev?authSource=admin&retryWrites=true&w=majority&tls=true`,
    };
    credential.password = "";
    loadHostedNormalEnvironment(env);
    await protectDirectory(directory);
    plain = Buffer.from(JSON.stringify(c));
    await writeFile(connectionFile, await dpapi(plain, "Protect"), {
      flag: "wx",
      mode: 0o600,
    });
    plain.fill(0);
    plain = Buffer.from(JSON.stringify(env));
    await writeFile(providerFile, await dpapi(plain, "Protect"), {
      flag: "wx",
      mode: 0o600,
    });
    plain.fill(0);
    plain = undefined;
    const identity = {
      mode: c.mode,
      apiOrigin,
      publicBase,
      publicDatabase: c.publicDatabase,
      streamId: c.streamId,
      configDigest: hostedNormalIdentity(c),
      normalRuntimeActivated: false,
    };
    await writeFile(
      join(directory, "../configuration-identity.json"),
      JSON.stringify(identity, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return identity;
  } finally {
    plain?.fill(0);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const value = (key) => {
    const i = process.argv.indexOf(key);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  prepareNormalHosting({
    apiOrigin: value("--api-origin"),
    publicBase: value("--public-origin"),
    confirmed: process.argv.includes("--confirm-prepare"),
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Normal hosting preparation refused. Preserve existing artifacts; no normal configuration was activated.",
      );
      process.exitCode = 1;
    });
}
