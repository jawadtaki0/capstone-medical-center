import { readFile, writeFile, realpath, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export async function runFullBackup() {
  if (process.cwd() !== root || !process.argv.includes("--confirm-full-backup"))
    throw Error(
      "Run from Capstone with --confirm-full-backup after operator approval.",
    );
  const selected = JSON.parse(
    await readFile(join(root, ".local/cedar-staff-launcher.json"), "utf8"),
  );
  if (selected.version !== 1 || selected.demoMode !== true)
    throw Error("Existing selected runtime required.");
  const runtime = await realpath(selected.runtimeDirectory);
  if (
    process.env.CAPSTONE_STAFF_RUNTIME_DIR &&
    (await realpath(process.env.CAPSTONE_STAFF_RUNTIME_DIR)) !== runtime
  )
    throw Error("Runtime differs from the selected launcher.");
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = runtime;
  const { connectStaffDatabase } = await import("../src/db.js");
  const { protectDirectory } = await import("../src/local-security.js");
  const {
    captureFullBackup,
    encodeFullBackup,
    decodeFullBackup,
    fullBackupSummary,
  } = await import("../src/full-backup.js");
  const connection = await connectStaffDatabase({
    database: "capstone_staff_dev",
    demoMode: true,
    initializeIndexes: false,
  });
  const path = join(
    root,
    ".local",
    "normal-release-backups",
    `full-${Date.now()}`,
  );
  try {
    await mkdir(path, { recursive: true });
    await protectDirectory(path);
    const snapshot = await captureFullBackup(connection);
    const file = join(path, "database.bson.encrypted");
    await writeFile(file, await encodeFullBackup(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    const verified = await decodeFullBackup(await readFile(file));
    const summary = fullBackupSummary(snapshot),
      readback = fullBackupSummary(verified);
    if (summary.digest !== readback.digest)
      throw Error("Backup readback mismatch.");
    await writeFile(
      join(path, "verification.json"),
      JSON.stringify(
        { ...summary, verified: true, restorePerformed: false },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({ ...summary, verified: true, privateDirectory: path }),
    );
  } finally {
    await connection.client.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runFullBackup().catch(() => {
    console.error(
      "Protected full backup failed. Preserve artifacts and reconcile; no database restore or index initialization was performed.",
    );
    process.exitCode = 1;
  });
