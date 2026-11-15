import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const patientIngressHeader = "x-cedar-patient-ingress";
export const validPatientIngressSecret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export function signPatientIngress(secret, path, ip, time = Date.now()) {
  const message = `${time}|${ip}|${path}`;
  const signature = createHmac("sha256", secret)
    .update(message)
    .digest("base64url");
  return `${time}|${ip}|${signature}`;
}

export function readPatientIngress(secret, path, header, now = Date.now()) {
  if (!validPatientIngressSecret(secret) || typeof header !== "string")
    return null;
  const match = /^(\d{13})\|([0-9a-fA-F:.]{1,45})\|([A-Za-z0-9_-]{43})$/.exec(
    header,
  );
  if (!match) return null;
  const [, time, ip] = match;
  if (!isIP(ip) || Math.abs(now - Number(time)) > 60_000) return null;
  const expected = signPatientIngress(secret, path, ip, Number(time));
  return timingSafeEqual(Buffer.from(expected), Buffer.from(header))
    ? ip.toLowerCase()
    : null;
}
