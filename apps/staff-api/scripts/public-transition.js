import { readFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { BSON, MongoClient } from "mongodb";
import { connectStaffDatabase } from "../src/db.js";
import { protectDirectory, runtimeDirectory } from "../src/local-security.js";
import { withPublicationOperatorLock } from "../src/publication-operator-lock.js";
import {
  loadPublicationConfig,
  provisionPublicationConfig,
  publicationEnvironment,
} from "../src/publication-config.js";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import {
  captureBsonSnapshot,
  writeBsonBackup,
  readBsonBackup,
  backupDigest,
  PUBLIC_BASELINE_COLLECTIONS,
  BACKUP_COLLECTIONS,
} from "../../api/src/public-data-backup.js";
import {
  planPublicBaseline,
  applyPublicBaseline,
  undoPublicBaseline,
  setPublicationPause,
} from "../src/public-baseline-import.js";
import {
  createPublicAuthority,
  legacyFingerprint,
  snapshotLegacyFingerprint,
} from "../../api/src/public-authority.js";
import { assertSinglePublicationStream } from "../../api/src/publication-receiver.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const privateRoot = join(root, ".local", "public-data-transition");
const actions = [
  "status",
  "backup",
  "plan",
  "configure",
  "freeze",
  "import",
  "undo-import",
  "activate",
  "rollback",
  "resume",
];
export function parseTransitionArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      ![
        "--action",
        "--source-backup",
        "--target-backup",
        "--digest",
        "--fingerprint",
        "--revision",
        "--accepted-digest",
        "--confirm",
      ].includes(key) ||
      !args[i + 1] ||
      Object.hasOwn(values, key)
    )
      throw new Error(
        "Use unique supported operator flags with explicit values.",
      );
    values[key] = args[i + 1];
  }
  if (!actions.includes(values["--action"]))
    throw new Error(
      `Select --action ${actions.join(" | ")}. No action runs by default.`,
    );
  return values;
}
async function checkedBackup(path) {
  const base = await realpath(privateRoot),
    actual = await realpath(resolve(path));
  const rel = relative(base, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(
      "Use a verified backup below the ignored local transition directory.",
    );
  return readBsonBackup(actual);
}
const confirmed = (args, phrase) => {
  if (args["--confirm"] !== phrase)
    throw new Error(`Explicit confirmation required: ${phrase}`);
};
// The role cutover may initialize working revision 1 before any public import.
// Bind admission to the verified target backup, never an assumed empty revision.
export function importRevisionFromBackup(backup) {
  const state = backup?.collections?.operational_state;
  if (
    !state ||
    typeof state.exists !== "boolean" ||
    !Array.isArray(state.raw) ||
    state.raw.length > 1 ||
    (!state.exists && state.raw.length)
  )
    throw new Error("Invalid target working-state backup.");
  if (!state.raw.length) return 0;
  const value = BSON.deserialize(state.raw[0]);
  if (
    value._id !== "working" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= Number.MAX_SAFE_INTEGER ||
    value.head !== 0
  )
    throw new Error(
      "Target backup has an invalid revision or existing publication.",
    );
  return value.revision;
}
async function run(args) {
  const action = args["--action"];
  if (action === "plan") {
    const plan = planPublicBaseline(
      await checkedBackup(args["--source-backup"]),
    );
    const snapshot = await checkedBackup(args["--source-backup"]);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          version: plan.version,
          capacityRule: plan.capacityRule,
          digest: plan.digest,
          sourceDigest: plan.sourceDigest,
          fingerprint: snapshotLegacyFingerprint(snapshot),
          effectiveFrom: plan.effectiveFrom,
          records: Object.fromEntries(
            Object.entries(plan.collections).map(([name, values]) => [
              name,
              values.length,
            ]),
          ),
          unconfiguredPatientLimits:
            plan.collections.operational_session_drafts.filter(
              (s) => s.professionalId && s.capacity === null,
            ).length,
          professionalSessions: plan.collections.operational_session_drafts
            .filter((s) => s.professionalId)
            .map(
              ({
                id,
                professionalId,
                weekday,
                startTime,
                endTime,
                capacity,
                appointmentRequired,
              }) => ({
                id,
                professionalId,
                weekday,
                startTime,
                endTime,
                capacity,
                appointmentRequired,
              }),
            ),
        },
        null,
        2,
      ),
    );
    return;
  }
  // Credentials stay within the existing API config -> Mongo driver boundary.
  // This tool never copies them into the staff config, output, arguments or assets.
  const env = parse(await readFile(join(root, "apps", "api", ".env")));
  const uri = process.env.MONGODB_URI ?? env.MONGODB_URI,
    database = process.env.MONGODB_DB_NAME ?? env.MONGODB_DB_NAME;
  const publicClient = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
  const target = { database, srvHost: publicClient.options.srvHost };
  const environment = { mode: "normal-local", publicTarget: target };
  const publicDb = publicClient.db(database);
  assertPublicationStorage(publicDb, publicClient, true, "public", environment);
  let staff;
  try {
    await publicClient.connect();
    await publicDb.command({ ping: 1 });
    staff = await connectStaffDatabase({
      database: "capstone_staff_dev",
      demoMode: true,
      initializeIndexes: false,
    });
    assertPublicationStorage(
      staff.db,
      staff.client,
      true,
      "staff",
      environment,
    );
    const config = await loadPublicationConfig();
    if (
      config &&
      (config.publicSrvHost !== target.srvHost ||
        config.publicDatabase !== database)
    )
      throw new Error(
        "Configured target differs. No credential/config replacement was attempted.",
      );
    const authority = createPublicAuthority({
      db: publicDb,
      client: publicClient,
      streamId: config?.streamId,
    });
    if (action === "status") {
      const source = await publicDb
          .collection("public_data_authority")
          .findOne({ _id: "source" }),
        state = await staff.db
          .collection("operational_state")
          .findOne({ _id: "working" }),
        accepted = config
          ? await publicDb
              .collection("public_publication_state")
              .findOne({ _id: config.streamId })
          : null;
      console.log(
        JSON.stringify(
          {
            mode: source?.mode ?? "legacy",
            sourceRevision: source?.revision ?? 0,
            writersFrozen: source?.writesFrozen === true,
            fingerprint: await legacyFingerprint(publicDb),
            staffHead: state?.head ?? 0,
            staffRevision: state?.revision ?? 0,
            publicationPaused: state?.publicationPaused === true,
            acceptedSequence: accepted?.sequence ?? 0,
            acceptedDigest: accepted?.digest ?? null,
            deliveryConfigured: Boolean(config),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (action === "backup") {
      confirmed(args, "BACK UP PUBLIC TRANSITION");
      await mkdir(privateRoot, { recursive: true });
      await protectDirectory(privateRoot);
      const base = join(privateRoot, `backup-${Date.now()}`);
      await mkdir(base);
      const source = await captureBsonSnapshot(publicDb, [
        ...PUBLIC_BASELINE_COLLECTIONS,
        "public_accepted_publications",
        "public_publication_state",
        "public_data_authority",
      ]);
      const targetSnapshot = await captureBsonSnapshot(
        staff.db,
        BACKUP_COLLECTIONS.filter(
          (name) =>
            name.startsWith("operational_") ||
            name.endsWith("_drafts") ||
            name === "public_publication_outbox",
        ),
      );
      console.log(
        await writeBsonBackup(join(base, "source"), source, {
          secureDirectory: protectDirectory,
        }),
      );
      console.log(
        await writeBsonBackup(join(base, "target"), targetSnapshot, {
          secureDirectory: protectDirectory,
        }),
      );
      console.log(
        "Backups verified. Normal records, reader selection and delivery configuration were not changed.",
      );
      return;
    }
    const sourceBackup = await checkedBackup(args["--source-backup"]);
    if (sourceBackup.database !== "medical-center-dev")
      throw new Error(
        "Use the approved normal public baseline backup, not TEST or another database.",
      );
    // The planner reads only the five source collections, even if the backup also contains receiver state.
    const snapshot = {
      ...sourceBackup,
      collections: Object.fromEntries(
        PUBLIC_BASELINE_COLLECTIONS.map((name) => [
          name,
          sourceBackup.collections[name],
        ]),
      ),
    };
    const plan = planPublicBaseline(snapshot);
    if (plan.digest !== args["--digest"])
      throw new Error("Reviewed plan digest differs. Repeat the dry-run.");
    const live = await captureBsonSnapshot(
      publicDb,
      PUBLIC_BASELINE_COLLECTIONS,
    );
    if (backupDigest(live) !== plan.sourceDigest)
      throw new Error(
        "Public baseline changed since backup. No import/source switch was performed.",
      );
    if (action === "configure") {
      confirmed(args, "CONFIGURE LOCAL PUBLICATION");
      const existingAuthority = await publicDb
        .collection("public_data_authority")
        .findOne({ _id: "source" });
      if (
        !config &&
        (existingAuthority?.streamId ||
          (await publicDb.collection("public_publication_state").findOne({})) ||
          (await publicDb
            .collection("public_accepted_publications")
            .findOne({})))
      )
        throw new Error(
          "Existing public stream requires reconciliation before new credential provisioning.",
        );
      if (config)
        await assertSinglePublicationStream(publicDb, config.streamId);
      const ledger = await staff.db
        .collection("operational_imports")
        .findOne({ _id: "public-baseline-v1" });
      if (ledger?.digest !== plan.digest || ledger.rolledBackAt)
        throw new Error(
          "Import the reviewed baseline before binding delivery configuration.",
        );
      const selected =
        config ??
        (await provisionPublicationConfig({
          publicSrvHost: target.srvHost,
          importDigest: plan.digest,
          confirmed: true,
        }));
      if (selected.importDigest !== plan.digest)
        throw new Error(
          "Existing configuration belongs to a different import.",
        );
      const session = staff.client.startSession();
      try {
        await session.withTransaction(async () => {
          await staff.db
            .collection("staff_management_state")
            .updateOne(
              { _id: "staff-controls" },
              { $inc: { revision: 1 } },
              { session },
            );
          const state = await staff.db
            .collection("operational_state")
            .findOne({ _id: "working" }, { session });
          const currentImport = await staff.db
            .collection("operational_imports")
            .findOne({ _id: "public-baseline-v1" }, { session });
          if (
            currentImport?.digest !== plan.digest ||
            currentImport.rolledBackAt
          )
            throw new Error(
              "Import changed during configuration. Reconcile before retrying.",
            );
          if (
            !state ||
            state.head !== 0 ||
            (state.streamId && state.streamId !== selected.streamId)
          )
            throw new Error("Existing publication stream cannot be replaced.");
          await staff.db
            .collection("operational_state")
            .updateOne(
              { _id: "working" },
              { $set: { streamId: selected.streamId } },
              { session },
            );
        });
      } finally {
        await session.endSession();
      }
      console.log(
        "Private delivery configuration preserved/bound. No message or publication sent. Service reload remains a separate operator action.",
      );
      return;
    }
    if (action === "freeze") {
      confirmed(args, "FREEZE LEGACY WRITERS");
      console.log(
        await authority.freeze({
          expectedFingerprint: args["--fingerprint"],
          confirmed: true,
        }),
      );
      return;
    }
    if (["import", "undo-import"].includes(action)) {
      confirmed(
        args,
        action === "import"
          ? "IMPORT REVIEWED BASELINE"
          : "UNDO UNCHANGED IMPORT",
      );
      const targetBackup = await checkedBackup(args["--target-backup"]);
      if (targetBackup.database !== "capstone_staff_dev")
        throw new Error("A verified operational target backup is required.");
      const currentTarget = await captureBsonSnapshot(
        staff.db,
        Object.keys(targetBackup.collections),
      );
      if (backupDigest(currentTarget) !== backupDigest(targetBackup))
        throw new Error(
          "Target changed since backup. Capture a fresh backup before importing or undoing.",
        );
      const source = await publicDb
        .collection("public_data_authority")
        .findOne({ _id: "source" });
      if (
        source?.mode !== "legacy" ||
        !source.writesFrozen ||
        source.legacyFingerprint !== (await legacyFingerprint(publicDb))
      )
        throw new Error(
          "Freeze/reconcile the legacy baseline before import or import undo.",
        );
      const result = await (
        action === "import" ? applyPublicBaseline : undoPublicBaseline
      )({
        ...staff,
        snapshot,
        expectedDigest: plan.digest,
        expectedRevision: importRevisionFromBackup(targetBackup),
        demoMode: true,
        environment,
      });
      console.log(result);
      return;
    }
    if (!config)
      throw new Error("Explicit delivery configuration is required.");
    if (action === "resume") {
      confirmed(args, "RESUME PUBLICATION");
      if ((await authority.mode()) !== "cedar")
        throw new Error(
          "Do not resume the Cedar writer while legacy is selected.",
        );
      const state = await staff.db
        .collection("operational_state")
        .findOne({ _id: "working" });
      await setPublicationPause({
        ...staff,
        expectedHead: state.head,
        paused: false,
      });
      console.log("Publication admission resumed.");
      return;
    }
    confirmed(
      args,
      action === "activate"
        ? "ACTIVATE CEDAR PUBLIC COPY"
        : "ROLL BACK BASELINE ONLY",
    );
    const revision = Number(args["--revision"]);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Supply the exact expected source revision.");
    // Cross-database transition is recoverable, not falsely described as one distributed transaction.
    // Pause staff admission first; any subsequent failure leaves it paused for explicit review/resume.
    await setPublicationPause({ ...staff, expectedHead: 1, paused: true });
    const result = await authority.switch({
      mode: action === "activate" ? "cedar" : "legacy",
      expectedRevision: revision,
      expectedSequence: 1,
      expectedDigest: args["--accepted-digest"],
      expectedLegacyFingerprint: args["--fingerprint"],
      confirmed: true,
    });
    if (action === "activate")
      await setPublicationPause({ ...staff, expectedHead: 1, paused: false });
    console.log(result);
  } finally {
    await staff?.client.close();
    await publicClient.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseTransitionArguments(process.argv.slice(2));
    if (args["--action"] === "plan") await run(args);
    else {
      await mkdir(privateRoot, { recursive: true });
      await protectDirectory(privateRoot);
      await withPublicationOperatorLock(runtimeDirectory, () => run(args));
    }
  } catch {
    console.error(
      "Public transition stopped safely. Check the action, confirmation, reviewed backup/digests, target identity and current revisions. No automatic retry, credential reset or fallback was performed. Publication may remain paused after a failed switch; reconcile before explicit resume.",
    );
    process.exitCode = 1;
  }
}
