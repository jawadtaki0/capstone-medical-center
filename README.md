# Medical Center Capstone

A medical-center website and operations-system capstone. Cedar is temporary prototype branding. Public doctor names and weekly hours use the owner's confirmed English schedule. Patient, booking, and messaging test data must be synthetic.

## Current status

The responsive Home and Schedule pages share the MongoDB-backed public schedule API. The weekly timetable repeats until an authorized Clinic Admin publishes a change. Monday–Friday: center 8:00 AM–5:00 PM, laboratory 8:00 AM–2:30 PM, audiometry 9:00 AM–2:30 PM. Saturday: center/laboratory 8:00 AM–1:00 PM and audiometry 9:00 AM–1:00 PM. Sunday is closed.

"No walk-in" is stored and displayed as **appointment required**. Phone and future online advance bookings remain possible. Booking capacity has not been confirmed and is absent from this model. Booking controls open a prototype message. Public/patient authentication, booking, Clinic Admin editing, patient records, lab results, billing and WhatsApp delivery are not implemented. The separate synthetic staff-access foundation is described below.

The licensed hero photo stays outside the public repository; deployment supplies it separately. Other branding, contact details and service copy remain provisional.

The public `/doctors` directory includes active doctors and specialists independently of their daily sessions. Search filters locally by name or specialty, including both the Therapist display label and its underlying specialty wording. Cards use supplied generic avatars and specialty icons; they contain no booking or contact controls. Our Doctors navigation opens the directory, while Home retains its separate Today's doctors preview. Doctors and Schedule use the shared Grainient page background; directory card backgrounds animate only during hover.

## Run locally

Use Node.js 22 or newer and MongoDB (local or a development Atlas database). Copy `apps/api/.env.example` to `apps/api/.env` and configure `MONGODB_URI` and `MONGODB_DB_NAME`. Keep credentials out of Git.

```powershell
npm install
npm run seed:schedule --workspace @medical-center/api
npm run dev
```

Open `http://localhost:5173`, `http://localhost:5173/doctors`, and `http://localhost:5173/schedule` (use the port Vite prints if 5173 is occupied). Vite proxies `/api` to `http://localhost:4000`. Inspect `/api/health`, `/api/professionals`, and `/api/schedule?date=2026-10-03`. Dates use Asia/Beirut. An unavailable MongoDB connection returns 503; a database without a published weekly timetable returns an unpublished state. The directory returns only stable public IDs, names, specialties, professional kind, and a safe server-derived `avatarVariant`; no eligible profiles means a genuinely empty directory.

Vite development and preview servers support direct loading/refreshing public routes through their SPA fallback. A deployment host must likewise serve `index.html` for `/doctors` and `/schedule` while routing `/api/*` to Express.

The API starts listening before MongoDB connects. Failed database connections are retried automatically after five seconds; once access is restored, use the page's Try again control. `/api/health` checks current database reachability rather than retaining a startup result. For Atlas, keep your current development IP in the project's IP Access List; connection recovery does not bypass Atlas access rules or TLS validation.

## Persistence and publishing model

- `doctor_profiles`: readable string `_id`, English `name`/`specialty`, `active`, and owner-confirmed `gender` (`male` or `female`). IDs look like `doctor:hasan-rahal`. Inactive profiles remain stored but are not public. Monday/Friday use the same Dr. Issam Al-Tawil profile.
- `specialist_profiles`: the same fields for the dietitian and therapists, with IDs such as `specialist:maya-najdi`. Neither profile collection stores `centerId`, `publicationStatus`, or `avatarVariant`.
- `weekly_schedules`: a complete seven-day timetable referencing profile IDs, center/service hours, session hours, appointment-required flags and session status. Weekday 0 is Sunday. The seed baseline has `effectiveFrom: null`; no starting date was supplied. A future published revision uses a confirmed `effectiveFrom: "YYYY-MM-DD"`.
- `schedule_date_changes`: a complete replacement `day` for one `date`, linked by `weeklyScheduleId` to the timetable being changed. It can change hours, add a session, retain a cancelled session, or close that date. An override belongs to its weekly revision; a future admin must review/rebase it when publishing a replacement revision.
- `schedule_seed_runs`: the `approved-weekly-v1` completion marker and its original `completedAt`.

Weekly timetables and date exceptions still require `publicationStatus: "published"`; profiles require only `active: true`. The API selects the latest effective weekly revision and then the latest published one-date replacement for that revision. Drafts remain hidden. Weekly records have no `centerId` or `source`; their baseline null effective date and publication timestamp are retained. A complete weekly document lets a future admin publish a coherent timetable in one write. Create/activate referenced profiles before publishing their sessions. Broken or inactive published profile references return an error rather than silently removing a professional. Keeping full profile history is a future enhancement.

The future authenticated Clinic Admin layer will manage drafts, validate references, set publication timestamps and audit the authorized publisher. This stage supplies the storage and read resolution, with **no schedule-writing HTTP endpoints**. GET requests perform no writes.

## Repeatable seed

The initial seed inserts 16 doctor profiles, 3 specialist profiles and one published weekly timetable. Stable IDs plus `$setOnInsert` protect existing records during partial-run recovery. Once the completion marker exists, reruns do no initialization writes, so later admin edits or removals are preserved. The reader never uses seed constants as fallback data.

To inspect MongoDB, use the database selected by `MONGODB_DB_NAME` and view `doctor_profiles`, `specialist_profiles`, `weekly_schedules`, `schedule_date_changes` and `schedule_seed_runs`. The baseline timetable ID is `weekly:approved-v1`. Existing namespaced data must be migrated before running initialization; its old completion marker also prevents accidental reseeding.

## Development schema migration and recovery

This narrowly scoped migration is restricted to the configured `medical-center-dev` database and requires a replica set with transactions. Keep the local API running with the migration read gate loaded. It never changes credentials, access rules, TLS settings, or other databases.

```powershell
npm run migrate:schema --workspace @medical-center/api -- --dry-run --database medical-center-dev
npm run migrate:schema --workspace @medical-center/api -- --apply --database medical-center-dev
```

Dry run is read-only and reports ID remaps, counts, and index cleanup. Apply first captures and verifies all six affected collections under ignored `.tmp/schema-cleanup/backups/<timestamp-id>/medical-center-dev/`. Each `.bson` contains the original BSON bytes; companion metadata preserves collection options/indexes, and `manifest.json` records counts and checksums. Treat these backups as private local artifacts, not Git content. The obsolete 12 `public_schedule_days` announcements are archived there, then that collection alone is dropped. Readers and initialization never reconstruct the timetable from these announcements.

Profiles, weekly references, date exceptions, and the completion marker are remapped together in one snapshot/majority transaction. Collisions, unknown profiles, missing references, or data changed since backup stop the migration. New Schedule/Directory requests temporarily receive 503; existing reads finish first. Health checks and database recovery remain available. Obsolete indexes and the archived legacy collection are removed after the transaction while the read gate remains closed. A second apply takes a fresh backup but performs no database writes once clean; completed seed reruns do not overwrite edits or resurrect removed profiles.

Recovery: inspect the backup's `result.json` before acting. A transaction failure rolls back the related record changes. A failure after commit can be recovered by rerunning the migration to finish index/archive cleanup. A hard process interruption can leave `.tmp/schema-cleanup/public-data.lock` in place (fail closed): confirm its PID is no longer running and review database/backup state before removing that exact lock file. Do not stop unrelated processes. For a deliberate rollback, use the original pre-migration BSON and metadata to restore only the backed-up collections in `medical-center-dev` while public readers are gated. Have the restore reviewed first; bulk restore overwrites later edits. MongoDB Database Tools can read these BSON dumps, but this increment does not execute a destructive restore or require those tools.

## Checks

```powershell
npm test
npm run test --workspace @medical-center/web
npm run build
git diff --check
```

Tests cover recurring weekdays, Saturday hours, Sunday closure, appointment-required flags, protected seed reruns, date overrides/cancellations, future publications, hidden drafts, Beirut dates, validation and read-only HTTP behavior. Migration tests cover ID/reference remapping, collisions, reruns, original BSON preservation, backup verification, concurrency guards, transaction-only replacement, and the public read gate. Date-change, migration, and future-admin tests use synthetic fixtures; tests do not write to MongoDB.

Directory tests also cover active-profile visibility/projection, inclusion of both professional types, local search/clearing, Therapist wording, server-derived avatars/failure handling, and retryable loading. Frontend tests retain coverage of all 14 supplied specialty icons, ENT aliases, and the unknown-specialty fallback. The owner confirms supplied icon/avatar assets are licensed; accompanying notices and visible avatar watermarks are preserved. See the asset READMEs for provenance. The server derives `avatarVariant` from stored gender without exposing raw gender; missing/invalid gender gives a neutral fallback. Frontend artwork selection uses this safe choice, not a profile-ID assignment list. Current stored Therapist wording and Zeinab Mkahhel spelling are preserved.

## Intended scope

The planned system includes public pages, full-doctor-session booking with shared online/receptionist capacity once confirmed, an FCFS check-in queue, staff-approved extra walk-ins, patient access to approved lab PDFs, and separate clinic/lab reception workflows. Development messaging uses mock/synthetic delivery; live WhatsApp requires authorized integration access. No online lab booking, online payment, pharmacy, insurance, AI chatbot or electronic doctor notes are planned for the first version.

## Windows staff-access development foundation

`apps/staff` packages a trusted local React interface in Electron; `apps/staff-api` is a separate Express authority. This increment contains one-time first-Admin setup, complete synthetic profile entry, password sign-in, mandatory authenticator MFA for the four administrative roles, private single-use backup codes, a permission-checked workspace, sign-out, and server-enforced session expiry. It does not contain account management or operational appointment, schedule, patient, lab or billing screens.

Use synthetic information only. The staff runtime never reads the public API's environment file or uses Atlas. It refuses targets other than its isolated loopback replica set and dedicated `capstone_staff_dev` / `capstone_staff_test` databases. One shared authority is intended; clients have no MongoDB credentials or independently writable database.

### Prepare and start

Requires Windows, Node 22.12 or newer, and the existing MongoDB Server 8.2 binary in its standard installation directory. Preparation creates a separate authenticated single-host replica set on **127.0.0.1:27018**, not the existing service on 27017. It creates no Windows service, firewall rule or certificate-trust setting. Persistent data, DPAPI-protected authority material and restricted local files live under `%LOCALAPPDATA%/CapstoneStaffDev`, outside the repository and OneDrive. Preparation is repeatable and never recreates an Admin automatically.

```powershell
npm install
npm run staff:prepare -- --demo-loopback
npm run staff:db -- --demo-loopback
```

Keep the database command running. In another terminal:

```powershell
npm run staff:bootstrap -- --demo-loopback
npm run staff:api -- --demo-loopback
```

In a third terminal:

```powershell
npm run staff:app -- --demo-loopback
```

HTTP requires the explicit `--demo-loopback` flag and is restricted to this computer. Without the flag, the app requires HTTPS and the development API refuses to start. There is no certificate-validation bypass or insecure LAN mode. The staff API uses 4100, separately from the public API's 4000.

Privately reveal the installation code in a local dialog, never in a log or screenshot:

```powershell
npm run staff:bootstrap -- --demo-loopback --reveal
```

It expires after 30 minutes and five incorrect attempts. Before the first account is created, `--reissue` replaces it and invalidates the previous code. After account creation bootstrap is permanently closed, even after a restart or account deletion. Choose your own 15–128-character passphrase; no preset Admin/password is provided. If setup stops during MFA, sign in with the chosen username/password to resume. The pending authenticator key survives interrupted enrollment. Backup codes are shown once; acknowledgement remains required after restart. If they were not saved, they cannot be redisplayed here; factor/code replacement is deferred. Recovery email is unverified and unused.

Background health/session polling never renews the session. Deliberate foreground input reports activity at most every 30 seconds. The warning appears after nine idle minutes; the server expires access at ten minutes and after eight hours absolutely. Tokens stay in Electron main-process memory, not renderer storage. API/database/key failure blocks access rather than permitting cached login.

### Tests and Windows package

With the separate staff database running:

```powershell
npm run staff:test
npm run staff:build
npm run test:electron --workspace @medical-center/staff
npm run staff:package
npm run test:electron --workspace @medical-center/staff -- --packaged
git diff --check
```

Integration/Electron tests are explicitly guarded to use only the seven synthetic staff collections in `capstone_staff_test`; they must run sequentially, not alongside another test run. They reset those fixtures, never the development/public databases. The Electron check saves only non-secret screens under ignored `.local/staff-review`.

Packaging produces `apps/staff/release/Cedar Staff Development Setup 0.1.0.exe` and `apps/staff/release/win-unpacked/Cedar Staff Development.exe`. Start the unpacked executable with `--demo-loopback` for the same-computer development demonstration. Release/test artifacts are ignored, not public source. This package is unsigned; installer creation or unpacked execution does not establish installation, code-signing, secure updates or real-center deployment readiness. Do not bypass Windows security warnings.

Local authentication uses bundled assets, a local API/database and authenticator codes; it has no CDN/cloud-authentication/email dependency. External-network independence is checked at application level without disconnecting the computer or changing its network settings. Multi-computer/LAN operation, remote access, server hardware/power, key backup/recovery and real-center installation remain unverified. A single-host replica set supports transactions but is not redundancy. Loss of both Admins' factors has no implemented recovery/backdoor, and bootstrap must not be rerun. Never delete the private runtime to attempt account recovery.
