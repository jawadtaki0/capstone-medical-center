import { readFile, writeFile, realpath, mkdir } from "node:fs/promises";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const privateRoot = join(root, ".local", "role-cutover");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const cutoverPlanDigest = (value) => hash(JSON.stringify(value));
class RoleCutoverError extends Error {}
const stop = (message) => {
  throw new RoleCutoverError(message);
};
export function safeCutoverFailure(error) {
  if (error instanceof RoleCutoverError) return error.message;
  if (error?.name === "MongoServerSelectionError")
    return "Configured local MongoDB is unavailable. Check the existing approved database startup; no service was started or restarted.";
  if (error?.code === "EEXIST")
    return "Private output already exists. Preserve it and choose a new reviewed filename; nothing was overwritten.";
  if (error?.code === "ENOENT")
    return "A required existing runtime, package or private artifact is missing. Check the selected paths; no configuration was created.";
  return "Role cutover refused. Check reviewed artifact identities, private paths, maintenance acknowledgement, idle staff port and exact local runtime/topology. No automatic restart, restore or retry occurred.";
}
export function parseNormalRoleArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        "--action",
        "--mappings",
        "--plan",
        "--backup",
        "--digest",
        "--backup-digest",
        "--app",
        "--confirm",
        "--normal-local",
        "--demo-loopback",
        "--acknowledge-maintenance-cutover",
      ].includes(key) ||
      Object.hasOwn(values, key)
    )
      stop("Use unique supported role-cutover flags.");
    if (
      [
        "--normal-local",
        "--demo-loopback",
        "--acknowledge-maintenance-cutover",
      ].includes(key)
    )
      values[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        stop("Missing explicit flag value.");
      values[key] = args[++i];
    }
  }
  if (
    !values["--normal-local"] ||
    !values["--demo-loopback"] ||
    !["dry-run", "backup", "verify", "apply"].includes(values["--action"])
  )
    stop(
      "Select an explicit normal-local role action and loopback mode. Nothing runs by default.",
    );
  if (!values["--mappings"] || !values["--plan"] || !values["--app"])
    stop("Explicit reviewed mappings, plan and package are required.");
  if (
    values["--action"] !== "dry-run" &&
    !/^[a-f0-9]{64}$/.test(values["--digest"] ?? "")
  )
    stop("Supply the reviewed plan digest.");
  if (
    ["backup", "verify", "apply"].includes(values["--action"]) &&
    !values["--backup"]
  )
    stop("Explicit protected backup path required.");
  if (
    ["verify", "apply"].includes(values["--action"]) &&
    !/^[a-f0-9]{64}$/.test(values["--backup-digest"] ?? "")
  )
    stop("Supply the verified backup digest.");
  if (["backup", "apply"].includes(values["--action"])) {
    if (!values["--acknowledge-maintenance-cutover"])
      stop(
        "Acknowledge ALL older staff APIs stopped and matching API/package selected; this tool never stops them.",
      );
    if (
      values["--confirm"] !==
      (values["--action"] === "backup"
        ? "BACK UP ROLE CUTOVER"
        : "APPLY REVIEWED ROLE CUTOVER")
    )
      stop("Explicit action confirmation required.");
  }
  return values;
}
export async function assertStaffPortIdle(port = 4100) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => {
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(1500, () =>
      finish(Error("Staff-port readiness is uncertain; maintenance refused.")),
    );
    socket.once("connect", () =>
      finish(
        Error(
          "Staff API port is occupied. Stop ALL older staff APIs through the approved maintenance procedure; no process was stopped.",
        ),
      ),
    );
    socket.once("error", (error) =>
      finish(
        error.code === "ECONNREFUSED"
          ? null
          : Error("Staff-port check failed; maintenance refused."),
      ),
    );
  });
}
export async function assertPrivateArtifactRoot(project, directory) {
  const canonical = await realpath(project);
  const parent = await realpath(dirname(directory));
  if (parent !== join(canonical, ".local"))
    stop(
      "Private artifact parent is redirected; no files or permissions changed.",
    );
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== join(canonical, ".local", "role-cutover"))
    stop("Private artifact directory is redirected; no permissions changed.");
}
export async function privateArtifactFile(directory, path, creating = false) {
  const base = await realpath(directory),
    candidate = resolve(path);
  const actual = creating
    ? join(await realpath(dirname(candidate)), basename(candidate))
    : await realpath(candidate);
  const rel = relative(base, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || /[\0\r\n]/.test(rel))
    stop(
      "Use a private artifact strictly below .local/role-cutover; links outside it are refused.",
    );
  return actual;
}
const privateFile = (path, creating = false) =>
  privateArtifactFile(privateRoot, path, creating);
async function runtimeAndPackage(appPath) {
  // Do this BEFORE importing local-security/config: they capture runtime on import.
  const selected = JSON.parse(
    await readFile(join(root, ".local", "cedar-staff-launcher.json"), "utf8"),
  );
  if (
    selected.version !== 1 ||
    selected.demoMode !== true ||
    !isAbsolute(selected.runtimeDirectory)
  )
    stop(
      "Existing explicit launcher runtime required; no new runtime is created.",
    );
  const runtime = await realpath(selected.runtimeDirectory);
  if (
    process.env.CAPSTONE_STAFF_RUNTIME_DIR &&
    (await realpath(process.env.CAPSTONE_STAFF_RUNTIME_DIR)) !== runtime
  )
    stop("Ambient runtime differs from the selected launcher runtime.");
  const authority = await readFile(join(runtime, "authority.dpapi")); // Encrypted bytes only.
  const release = await realpath(join(root, "apps", "staff", "release"));
  const app = await realpath(resolve(appPath));
  const rel = relative(release, app);
  if (
    !rel ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    basename(app) !== "Cedar Staff Development.exe"
  )
    stop("Select the exact reviewed local package under apps/staff/release.");
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = runtime; // This owned process only.
  const operator = [];
  for (const path of [
    "src/role-migration.js",
    "src/role-cutover-backup.js",
    "scripts/normal-role-cutover.js",
    "src/config.js",
    "src/db.js",
    "src/permissions.js",
    "src/management.js",
    "src/operational-model.js",
    "src/password-history.js",
    "src/local-security.js",
    "src/publication-operator-lock.js",
    "../../shared/staff-roles.mjs",
    "../../shared/publication-environment.mjs",
    "../../shared/publication-review-guard.mjs",
  ])
    operator.push([
      path,
      hash(await readFile(join(root, "apps", "staff-api", path))),
    ]);
  return {
    runtime,
    context: {
      mode: "normal-local",
      database: "capstone_staff_dev",
      demoMode: true,
      runtimeFingerprint: hash(
        JSON.stringify(["role-cutover:v1", runtime, hash(authority)]),
      ),
    },
    packageIdentity: {
      path: app,
      executable: hash(await readFile(app)),
      archive: hash(await readFile(resolve(app, "../resources/app.asar"))),
    },
    operator,
  };
}
export async function runNormalRoleCutover(args) {
  if (process.cwd() !== root)
    stop("Run the operator from the active project root.");
  const selected = await runtimeAndPackage(args["--app"]);
  const { connectStaffDatabase } = await import("../src/db.js");
  const { protectDirectory } = await import("../src/local-security.js");
  const { roleSnapshot, planRoleMigration, applyRoleMigration } =
    await import("../src/role-migration.js");
  const backupTools = await import("../src/role-cutover-backup.js");
  const { withPublicationOperatorLock } =
    await import("../src/publication-operator-lock.js");
  await assertPrivateArtifactRoot(root, privateRoot);
  await protectDirectory(privateRoot); // Only this private artifact directory.
  const mappings = JSON.parse(
    await readFile(await privateFile(args["--mappings"]), "utf8"),
  );
  const action = args["--action"];
  if (["backup", "apply"].includes(action)) await assertStaffPortIdle();
  const connection = await connectStaffDatabase({
    database: "capstone_staff_dev",
    demoMode: true,
    initializeIndexes: false,
  });
  const { db, client } = connection;
  const { context } = selected;
  backupTools.assertNormalRoleTarget(db, client, context);
  const session = client.startSession();
  try {
    const operation = async () => {
      if (["backup", "apply"].includes(action)) await assertStaffPortIdle();
      if (action === "dry-run") {
        const plan = await session.withTransaction(
          async () =>
            planRoleMigration(await roleSnapshot(db, session), mappings),
          { readConcern: { level: "snapshot" } },
        );
        const document = {
          version: 1,
          context,
          packageIdentity: selected.packageIdentity,
          operator: selected.operator,
          mappings,
          plan,
        };
        const digest = cutoverPlanDigest(document);
        await writeFile(
          await privateFile(args["--plan"], true),
          JSON.stringify({ ...document, digest }, null, 2),
          { flag: "wx", mode: 0o600 },
        );
        console.log(
          JSON.stringify({
            status: plan.problems.length ? "needs_review" : "planned",
            digest,
            problems: plan.problems.length,
            accounts: plan.changes.length,
          }),
        );
        return;
      }
      const saved = JSON.parse(
        await readFile(await privateFile(args["--plan"]), "utf8"),
      );
      const { digest, ...body } = saved;
      if (
        digest !== args["--digest"] ||
        cutoverPlanDigest(body) !== digest ||
        JSON.stringify(body.context) !== JSON.stringify(context) ||
        JSON.stringify(body.packageIdentity) !==
          JSON.stringify(selected.packageIdentity) ||
        JSON.stringify(body.operator) !== JSON.stringify(selected.operator) ||
        JSON.stringify(body.mappings) !== JSON.stringify(mappings) ||
        body.plan.problems.length
      )
        stop(
          "Reviewed plan/runtime/package/source/mappings differ. Regenerate and review; no apply attempted.",
        );
      if (action === "backup") {
        const metadata = await backupTools.roleCollectionMetadata(db);
        const value = await session.withTransaction(
          async () => {
            const current = planRoleMigration(
              await roleSnapshot(db, session),
              mappings,
            );
            if (current.digest !== body.plan.digest)
              stop("Account/grant/policy state changed; regenerate the plan.");
            return {
              version: 1,
              database: db.databaseName,
              runtimeFingerprint: context.runtimeFingerprint,
              snapshotDigest: current.snapshotDigest,
              collections: await backupTools.captureRoleState(
                db,
                session,
                metadata,
              ),
            };
          },
          { readConcern: { level: "snapshot" } },
        );
        const file = await privateFile(args["--backup"], true);
        await writeFile(file, await backupTools.encodeRoleBackup(value), {
          flag: "wx",
          mode: 0o600,
        });
        const verified = await backupTools.decodeRoleBackup(
          await readFile(file),
        );
        if (
          backupTools.roleBackupDigest(value) !==
          backupTools.roleBackupDigest(verified)
        )
          stop("Backup readback differs; preserve the file and investigate.");
        console.log(
          JSON.stringify({
            status: "backup_verified",
            digest: backupTools.roleBackupDigest(verified),
          }),
        );
        return;
      }
      const backup = await backupTools.decodeRoleBackup(
        await readFile(await privateFile(args["--backup"])),
      );
      if (
        backupTools.roleBackupDigest(backup) !== args["--backup-digest"] ||
        backup.database !== context.database ||
        backup.runtimeFingerprint !== context.runtimeFingerprint ||
        backup.snapshotDigest !== body.plan.snapshotDigest
      )
        stop("Protected backup identity differs.");
      if (action === "verify") {
        console.log(
          JSON.stringify({
            status: "backup_verified",
            digest: args["--backup-digest"],
          }),
        );
        return;
      }
      // Metadata/DDL is checked outside the transaction; the maintenance freeze
      // must prevent schema changes. Raw affected data is rechecked INSIDE apply.
      const completed = await db
        .collection("staff_role_migrations")
        .findOne({ _id: body.plan.policy }, { projection: { digest: 1 } });
      if (!completed) {
        const metadata = await backupTools.roleCollectionMetadata(db);
        for (const name of backupTools.ROLE_BACKUP_COLLECTIONS) {
          const { raw, ...savedMetadata } = backup.collections[name];
          if (JSON.stringify(savedMetadata) !== JSON.stringify(metadata[name]))
            stop("Collection metadata changed; reconcile before apply.");
        }
      }
      console.log(
        JSON.stringify(
          await applyRoleMigration({
            ...connection,
            demoMode: true,
            mappings,
            plan: body.plan,
            context,
            backup,
            expectedBackupDigest: args["--backup-digest"],
            maintenanceAcknowledged: true,
          }),
        ),
      );
    };
    if (["backup", "apply"].includes(action))
      await withPublicationOperatorLock(selected.runtime, operation);
    else await operation();
  } finally {
    await session.endSession();
    await client.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runNormalRoleCutover(parseNormalRoleArguments(process.argv.slice(2)));
  } catch (error) {
    // Driver/DPAPI errors can carry private values. Never dump error objects.
    console.error(safeCutoverFailure(error));
    process.exitCode = 1;
  }
}
