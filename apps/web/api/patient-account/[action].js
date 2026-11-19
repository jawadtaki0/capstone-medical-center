import { isIP } from "node:net";
import {
  patientIngressHeader,
  signPatientIngress,
  validPatientIngressSecret,
} from "../../../../shared/patient-ingress.mjs";

const publicOrigin = "https://cedar-cmc.vercel.app";
const apiOrigin = "https://cedar-cmc-api.onrender.com";
const actions = new Set([
  "signup",
  "activate",
  "signin",
  "username-suggestions",
  "recover",
  "reset",
  "replace-email",
  "verify-email",
  "signout",
  "delete",
  "add-profiles",
  "profile-requests",
  "family-profiles",
  "lab-reports",
  "lab-report",
  "book",
  "phone-request",
  "phone-status",
  "phone-verify",
  "phone-recover",
  "phone-reset",
]);

export function createPatientAccountProxy({ secret, send = fetch } = {}) {
  return async (request) => {
    const headers = {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    };
    const reply = (status, error) =>
      Response.json({ error }, { status, headers });
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      !actions.has(path.split("/").at(-1)) ||
      !/^\/api\/patient-account\/[a-z-]+$/.test(path)
    )
      return reply(404, "not_found");
    const contentType = request.headers.get("content-type");
    if (
      request.headers.get("origin") !== publicOrigin ||
      !/^application\/json(?:\s*;|$)/i.test(contentType ?? "")
    )
      return reply(403, "invalid_origin");
    const ip = request.headers.get("x-vercel-forwarded-for");
    if (!validPatientIngressSecret(secret) || !ip || !isIP(ip))
      return reply(503, "try_later");
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > 4096) return reply(400, "invalid_input");
      const upstreamHeaders = new Headers({
        Origin: publicOrigin,
        "Content-Type": contentType,
        [patientIngressHeader]: signPatientIngress(secret, path, ip),
      });
      const cookie = request.headers.get("cookie");
      if (cookie) upstreamHeaders.set("Cookie", cookie);
      const upstream = await send(new URL(path, apiOrigin), {
        method: "POST",
        body,
        headers: upstreamHeaders,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const outgoing = new Headers(headers);
      outgoing.set(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      for (const cookie of upstream.headers.getSetCookie())
        outgoing.append("Set-Cookie", cookie);
      const disposition = upstream.headers.get("content-disposition");
      if (path.endsWith("/lab-report") && disposition)
        outgoing.set("Content-Disposition", disposition);
      outgoing.set("X-Content-Type-Options", "nosniff");
      return new Response(upstream.body, {
        status: upstream.status,
        headers: outgoing,
      });
    } catch {
      return reply(503, "try_later");
    }
  };
}

export default {
  fetch: createPatientAccountProxy({
    secret: process.env.CEDAR_PATIENT_INGRESS_SECRET,
  }),
};
