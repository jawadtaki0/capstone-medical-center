import { access, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateRecoveryForm } from "./private-recovery-form.js";
import { dpapi, protectDirectory } from "../src/local-security.js";

export const normalCredentialDirectory = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
  ".local/normal-hosting/private",
);
export async function configureHostedNormalCredential({
  directory = normalCredentialDirectory,
  entry = privateRecoveryForm,
  protect = protectDirectory,
  encrypt = (v) => dpapi(v, "Protect"),
  save = writeFile,
  exists = access,
} = {}) {
  const destination = join(directory, "atlas-normal.dpapi");
  try {
    await exists(destination);
    throw Error("Existing normal credential preserved.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const values = await entry({
    purpose: "hosted-normal",
    note: "Enter only the saved password for the dedicated normal capstone Atlas user. No connection or activation is made. Never share or screenshot it.",
    fields: [
      {
        label: "Atlas capstone username",
        value: "cedar_public_capstone",
        readOnly: true,
      },
      { label: "Database scope", value: "medical-center-dev", readOnly: true },
      {
        label: "Saved Atlas capstone password",
        value: "",
        private: true,
        asteriskMask: true,
      },
    ],
  });
  if (values === null) return { status: "cancelled" };
  if (
    !Array.isArray(values) ||
    values.length !== 3 ||
    values[0] !== "cedar_public_capstone" ||
    values[1] !== "medical-center-dev" ||
    typeof values[2] !== "string" ||
    !values[2].length ||
    values[2].length > 512 ||
    /[\r\n\0]/.test(values[2])
  )
    throw Error("Invalid private entry.");
  const plain = Buffer.from(
    JSON.stringify({
      version: 1,
      username: values[0],
      database: values[1],
      password: values[2],
    }),
  );
  values.fill("");
  try {
    await protect(directory);
    await save(destination, await encrypt(plain), { flag: "wx", mode: 0o600 });
    return { status: "saved" };
  } finally {
    plain.fill(0);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  configureHostedNormalCredential()
    .then((r) =>
      console.log(
        r.status === "saved"
          ? "Normal capstone credential encrypted locally."
          : "Cancelled; no credential saved.",
      ),
    )
    .catch(() => {
      console.error(
        "Normal credential entry failed; existing credentials preserved. Use the signed-in Windows desktop.",
      );
      process.exitCode = 1;
    });
}
