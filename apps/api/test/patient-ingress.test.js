import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createNormalSource } from "../src/hosted-normal.js";
import { createPatientAccountProxy } from "../../web/api/patient-account/[action].js";
import { patientIngressHeader } from "../../../shared/patient-ingress.mjs";

test("patient account POSTs preserve the Vercel client address and response contract", async () => {
  const secret = randomBytes(32).toString("base64url");
  const apiOrigin = "https://cedar-cmc-api.onrender.com";
  const publicOrigin = "https://cedar-cmc.vercel.app";
  const path = "/api/patient-account/signin";
  const source = createNormalSource(
    {
      CEDAR_NORMAL_TRUSTED_PROXY: "render-cloudflare-client",
      CEDAR_PATIENT_INGRESS_SECRET: secret,
    },
    { apiOrigin },
  );
  const relay = createPatientAccountProxy({
    secret,
    async send(url, options) {
      assert.equal(url.href, apiOrigin + path);
      assert.equal(options.headers.get("Cookie"), "cedar=fictional");
      assert.equal(options.redirect, "error");
      const renderHeaders = new Headers(options.headers);
      renderHeaders.set("Host", new URL(apiOrigin).host);
      renderHeaders.set("CF-Connecting-IP", "192.0.2.80");
      assert.equal(
        source({
          method: "POST",
          originalUrl: path,
          get: (name) => renderHeaders.get(name) ?? undefined,
        }),
        "192.0.2.42",
      );
      return Response.json(
        { account: null },
        {
          headers: { "Set-Cookie": "cedar=test; Secure; HttpOnly; Path=/" },
        },
      );
    },
  });
  const response = await relay(
    new Request(publicOrigin + path, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
        Cookie: "cedar=fictional",
        "X-Vercel-Forwarded-For": "192.0.2.42",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.deepEqual(await response.json(), { account: null });
  assert.equal(
    source({
      get: (name) =>
        ({
          Host: new URL(apiOrigin).host,
          "CF-Connecting-IP": "192.0.2.24",
        })[name],
    }),
    "192.0.2.24",
  );
  assert.equal(response.headers.has(patientIngressHeader), false);
});
