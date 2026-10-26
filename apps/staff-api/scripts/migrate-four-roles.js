import { readFile } from "node:fs/promises";
import { connectStaffDatabase } from "../src/db.js";
import {
  inspectRoleMigration,
  applyRoleMigration,
} from "../src/role-migration.js";

// This increment deliberately exposes TEST rehearsal only. Normal cutover needs
// separate inventory, per-account approval, backup and maintenance authorization.
const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1];
};
let connection;
try {
  if (
    !args.includes("--test-only") ||
    !args.includes("--demo-loopback") ||
    !["dry-run", "apply"].includes(args[0])
  )
    throw Error(
      "Use dry-run or apply with --test-only --demo-loopback. Normal migration is not enabled.",
    );
  const mappings = value("--mappings")
    ? JSON.parse(await readFile(value("--mappings"), "utf8"))
    : {};
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
    initializeIndexes: false,
  });
  const options = { ...connection, mappings, demoMode: true };
  const result =
    args[0] === "dry-run"
      ? await inspectRoleMigration(options)
      : await applyRoleMigration({
          ...options,
          plan: JSON.parse(await readFile(value("--plan"), "utf8")),
          maintenanceAcknowledged: args.includes(
            "--acknowledge-maintenance-cutover",
          ),
        });
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error(
    "Role rehearsal refused. Check TEST target, approved mappings, plan identity and maintenance acknowledgement. No normal migration is enabled.",
  );
  process.exitCode = 1;
} finally {
  await connection?.client.close();
}
