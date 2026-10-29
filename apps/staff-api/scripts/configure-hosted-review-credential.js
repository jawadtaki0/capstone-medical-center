import { access, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateRecoveryForm } from "./private-recovery-form.js";
import { dpapi, protectDirectory } from "../src/local-security.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export const reviewCredentialDirectory = resolve(
  repository,
  ".local/website-requests-hosting/private",
);

// This operator has no database/provider client and never activates delivery.
// Captured private entry goes straight to DPAPI; existing files are never replaced.
export async function configureHostedReviewCredential({
  directory = reviewCredentialDirectory,
  entry = privateRecoveryForm,
  protect = protectDirectory,
  encrypt = (value) => dpapi(value, "Protect"),
  save = writeFile,
  exists = access,
} = {}) {
  const destination = join(directory, "atlas-review.dpapi");
  try {
    await exists(destination);
    throw new Error("Existing review credential preserved; entry refused.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = await entry({
    purpose: "hosted-review",
    note: "Enter only the password you just saved for the isolated Atlas review user. No connection, message or deployment is made. Cancel saves nothing.",
    fields: [
      {
        label: "Atlas review username",
        value: "cedar_public_review",
        readOnly: true,
      },
      {
        label: "Database scope",
        value: "capstone_public_review",
        readOnly: true,
      },
      { label: "Saved Atlas review password", value: "", private: true },
    ],
  });
  if (result === null) return { status: "cancelled" };
  if (
    !Array.isArray(result) ||
    result.length !== 3 ||
    result[0] !== "cedar_public_review" ||
    result[1] !== "capstone_public_review" ||
    typeof result[2] !== "string" ||
    result[2].length < 1 ||
    result[2].length > 512 ||
    /[\r\n\0]/.test(result[2])
  )
    throw new Error("Invalid review entry; nothing saved.");
  const plain = Buffer.from(
    JSON.stringify({
      version: 1,
      username: result[0],
      database: result[1],
      password: result[2],
    }),
  );
  result.fill("");
  try {
    await protect(directory);
    const encrypted = await encrypt(plain);
    await save(destination, encrypted, { flag: "wx", mode: 0o600 });
    return { status: "saved" };
  } finally {
    plain.fill(0);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      "Opening private review credential entry. Enter secrets only in its masked field; Cancel saves nothing.",
    );
    const result = await configureHostedReviewCredential();
    console.log(
      result.status === "saved"
        ? "Review credential encrypted locally. No connections or messages were sent."
        : "Cancelled. Nothing saved.",
    );
  } catch {
    console.error(
      "Review credential not saved. Existing settings preserved. Retry from your signed-in Windows desktop; never enter secrets in chat or CMD arguments.",
    );
    process.exitCode = 1;
  }
}
