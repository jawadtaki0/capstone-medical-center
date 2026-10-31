import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPublicationConfig } from "../src/publication-config.js";
import { loadRequestConfig } from "../src/request-integration.js";
import { configureHostedNormalCredential } from "../scripts/configure-hosted-normal-credential.js";

const config = () => ({
  version: 1,
  mode: "normal-hosted",
  capstoneDemo: true,
  apiOrigin: "https://cedar-cmc-api.onrender.com",
  publicBase: "https://cedar-cmc.vercel.app",
  publicDatabase: "medical-center-dev",
  publicSrvHost: "synthetic.example.mongodb.net",
  streamId: "stream:00000000-0000-4000-8000-000000000001",
  importDigest: "d".repeat(64),
  token: "a".repeat(43),
  credential: "b".repeat(43),
  key: "c".repeat(43),
  contact: "Synthetic contact",
});
test("protected normal connection binds both transports and corrupt configuration never falls back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedar-normal-config-")),
    unwrap = async (b) => Buffer.from(b);
  try {
    await writeFile(
      join(directory, "hosted-normal.dpapi"),
      JSON.stringify(config()),
    );
    const p = await loadPublicationConfig({ directory, unwrap }),
      r = await loadRequestConfig({ directory, unwrap });
    assert.equal(p.target, config().apiOrigin + "/api/publications");
    assert.equal(r.target, config().apiOrigin + "/api/requests/integration");
    assert.equal(p.token, config().token);
    assert.equal(r.credential, config().credential);
    assert(Buffer.isBuffer(r.key));
    await writeFile(
      join(directory, "hosted-normal.dpapi"),
      JSON.stringify({ ...config(), publicDatabase: "capstone_public_review" }),
    );
    await assert.rejects(loadPublicationConfig({ directory, unwrap }));
    await assert.rejects(loadRequestConfig({ directory, unwrap }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("private normal credential entry preserves existing credentials and only saves captured dummy material encrypted", async () => {
  let prompted = 0,
    saved;
  await assert.rejects(
    configureHostedNormalCredential({
      exists: async () => {},
      entry: async () => {
        prompted++;
      },
    }),
    /preserved/,
  );
  assert.equal(prompted, 0);
  const missing = Object.assign(Error("missing"), { code: "ENOENT" });
  const result = await configureHostedNormalCredential({
    exists: async () => {
      throw missing;
    },
    entry: async () => [
      "cedar_public_capstone",
      "medical-center-dev",
      "dummy-only-password",
    ],
    protect: async () => {},
    encrypt: async () => Buffer.from("encrypted-dummy"),
    save: async (path, bytes, options) => {
      saved = { path, bytes, options };
    },
  });
  assert.equal(result.status, "saved");
  assert.equal(saved.options.flag, "wx");
  assert.equal(saved.bytes.toString(), "encrypted-dummy");
});
