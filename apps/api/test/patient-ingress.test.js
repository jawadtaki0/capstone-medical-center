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

test("Lab PDF relay preserves exact bytes and private attachment headers", async () => {
  const path = "/api/patient-account/lab-report";
  const pdf = Buffer.from("%PDF-1.7\nFictional Lab report\n");
  const disposition = 'attachment; filename="LAB-fictional.pdf"';
  const relay = createPatientAccountProxy({
    secret: randomBytes(32).toString("base64url"),
    async send(url, { method, headers }) {
      assert.equal(url.pathname, path);
      assert.equal(method, "POST");
      assert.equal(headers.get("cookie"), "cedar=fictional");
      assert.ok(headers.has(patientIngressHeader));
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": disposition,
        },
      });
    },
  });
  const response = await relay(
    new Request("https://cedar-cmc.vercel.app" + path, {
      method: "POST",
      headers: {
        Origin: "https://cedar-cmc.vercel.app",
        "Content-Type": "application/json",
        Cookie: "cedar=fictional",
        "X-Vercel-Forwarded-For": "192.0.2.42",
      },
      body: JSON.stringify({ patientId: "fictional", reportId: "fictional" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Content-Disposition"), disposition);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
});

test("Cedar website origins relay only their own same-origin requests", async () => {
  const path = "/api/patient-account/signin";
  const existing = "https://cedar-cmc.vercel.app";
  const custom = "https://cmc-cedar.site";
  const unrelated = "https://example.test";
  let forwarded = 0;
  const relay = createPatientAccountProxy({
    secret: randomBytes(32).toString("base64url"),
    async send(url, options) {
      forwarded++;
      assert.equal(options.headers.get("Origin"), existing);
      assert.ok(options.headers.has(patientIngressHeader));
      return Response.json({ account: null });
    },
  });
  for (const [host, origin, status] of [
    [existing, existing, 200],
    [custom, custom, 200],
    [custom, existing, 403],
    [existing, custom, 403],
    [unrelated, unrelated, 403],
    [unrelated, custom, 403],
  ]) {
    const response = await relay(new Request(host + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Vercel-Forwarded-For": "192.0.2.42",
      },
      body: "{}",
    }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal(forwarded, 2);
});
