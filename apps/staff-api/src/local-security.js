import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";

const exec = promisify(execFile);
// Packaged Windows hosts may redirect AppData writes. An ordinary terminal can
// explicitly use that same existing runtime without copying or regenerating
// keys. This is a process-local path setting, not a database target override.
export function resolveRuntimeDirectory(
  environment = process.env,
  userHome = homedir(),
) {
  const explicitDirectory = environment.CAPSTONE_STAFF_RUNTIME_DIR;
  if (explicitDirectory !== undefined) {
    const localWindowsPath =
      typeof explicitDirectory === "string" &&
      (process.platform !== "win32" ||
        (/^[A-Za-z]:[\\/]/.test(explicitDirectory) &&
          !explicitDirectory.slice(2).includes(":")));
    if (
      typeof explicitDirectory !== "string" ||
      !explicitDirectory ||
      explicitDirectory !== explicitDirectory.trim() ||
      explicitDirectory.includes("\0") ||
      !isAbsolute(explicitDirectory) ||
      !localWindowsPath
    ) {
      throw new Error(
        "CAPSTONE_STAFF_RUNTIME_DIR must be an absolute local directory.",
      );
    }
    return normalize(explicitDirectory);
  }
  return join(
    environment.LOCALAPPDATA || join(userHome, "AppData", "Local"),
    "CapstoneStaffDev",
  );
}

export const runtimeDirectory = resolveRuntimeDirectory();

export async function protectDirectory(path = runtimeDirectory) {
  if (process.platform !== "win32")
    throw new Error("This development key store requires Windows.");
  await mkdir(path, { recursive: true });
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { windowsHide: true },
  );
  const sid = stdout.trim();
  if (!/^S-1-5-[\d-]+$/.test(sid))
    throw new Error("Windows key owner could not be verified.");
  await exec(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
    { windowsHide: true },
  );
}

// Windows supplies DPAPI; secrets travel over child-process pipes, never arguments/logs.
export function dpapi(value, mode) {
  if (process.platform !== "win32" || !["Protect", "Unprotect"].includes(mode))
    throw new Error("Windows key protection unavailable.");
  const command = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${mode}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Windows key protection timed out."));
    }, 15000);
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows key protection unavailable."));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(output))
        reject(new Error("Windows key protection failed."));
      else resolve(Buffer.from(output, "base64"));
    });
    child.stdin.end(Buffer.from(value).toString("base64"));
  });
}

export async function readAuthority() {
  const wrapped = await readFile(join(runtimeDirectory, "authority.dpapi"));
  const plain = await dpapi(wrapped, "Unprotect");
  try {
    return JSON.parse(plain.toString("utf8"));
  } finally {
    plain.fill(0);
  }
}

export async function initializeAuthority() {
  await protectDirectory();
  const file = join(runtimeDirectory, "authority.dpapi");
  try {
    await access(file);
    return await readAuthority();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // The caller must establish a fresh private data directory before calling this.
  const authority = {
    version: 1,
    runtimeId: randomBytes(16).toString("hex"),
    key: randomBytes(32).toString("base64"),
    rootPassword: randomBytes(32).toString("base64url"),
    appPassword: randomBytes(32).toString("base64url"),
    testPassword: randomBytes(32).toString("base64url"),
    replicaKey: randomBytes(64).toString("base64"),
  };
  const wrapped = await dpapi(
    Buffer.from(JSON.stringify(authority)),
    "Protect",
  );
  await writeFile(file, wrapped, { flag: "wx" });
  return authority;
}

export function createVault(keyBase64) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("MFA protection key unavailable.");
  return {
    // Domain-separated keyed digests protect low-entropy contact codes and
    // destination identifiers without generating or replacing authority keys.
    contactDigest(value) {
      return createHmac("sha256", key)
        .update("capstone-staff-contact:v1\0")
        .update(value)
        .digest("hex");
    },
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("capstone-staff-mfa:v1"));
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return {
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: encrypted.toString("base64"),
      };
    },
    decrypt(record) {
      if (record?.version !== 1)
        throw new Error("MFA factor cannot be decrypted.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAAD(Buffer.from("capstone-staff-mfa:v1"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
    destroy() {
      key.fill(0);
    },
  };
}
