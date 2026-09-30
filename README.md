# Medical Center Capstone

A medical-center website and operations-system capstone. Cedar is temporary prototype branding. Public doctor names and weekly hours use the owner's confirmed English schedule. Patient, booking, and messaging test data must be synthetic.

## Current status

The responsive Home and Schedule pages share the MongoDB-backed public schedule API. The weekly timetable repeats until an authorized Clinic Admin publishes a change. Monday–Friday: center 8:00 AM–5:00 PM, laboratory 8:00 AM–2:30 PM, audiometry 9:00 AM–2:30 PM. Saturday: center/laboratory 8:00 AM–1:00 PM and audiometry 9:00 AM–1:00 PM. Sunday is closed.

"No walk-in" is stored and displayed as **appointment required**. Phone and future online advance bookings remain possible. Booking capacity has not been confirmed and is absent from this model. Booking controls open a prototype message. Authentication, booking, Clinic Admin editing, patient records, lab results, billing and WhatsApp delivery are not implemented.

The licensed hero photo stays outside the public repository; deployment supplies it separately. Other branding, contact details and service copy remain provisional.

## Run locally

Use Node.js 22 or newer and MongoDB (local or a development Atlas database). Copy `apps/api/.env.example` to `apps/api/.env` and configure `MONGODB_URI` and `MONGODB_DB_NAME`. Keep credentials out of Git.

```powershell
npm install
npm run seed:schedule --workspace @medical-center/api
npm run dev
```

Open `http://localhost:5173` and `http://localhost:5173/schedule`. Vite proxies `/api` to `http://localhost:4000`. Inspect `/api/health` and `/api/schedule?date=2026-10-03`. Dates use Asia/Beirut. An unavailable MongoDB connection returns 503; a database without a published weekly timetable returns an unpublished state.

## Persistence and publishing model

- `doctor_profiles`: stable ID, center ID, English name/specialty, `publicationStatus`, and `active`. Monday/Friday use the same Dr. Issam Al-Tawil profile.
- `specialist_profiles`: the same profile fields for the dietitian and therapists.
- `weekly_schedules`: a complete seven-day timetable referencing profile IDs, center/service hours, session hours, appointment-required flags and session status. Weekday 0 is Sunday. The seed baseline has `effectiveFrom: null`; no starting date was supplied. A future published revision uses a confirmed `effectiveFrom: "YYYY-MM-DD"`.
- `schedule_date_changes`: a complete replacement `day` for one `date`, linked by `weeklyScheduleId` to the timetable being changed. It can change hours, add a session, retain a cancelled session, or close that date. An override belongs to its weekly revision; a future admin must review/rebase it when publishing a replacement revision.
- `schedule_seed_runs`: completion marker for the approved initial seed.

Only `publicationStatus: "published"` documents are read by the API. It selects the latest effective weekly revision and then the latest published one-date replacement for that revision. Drafts remain hidden. A complete weekly document lets a future admin publish a coherent timetable in one write. For new doctors, publish their profiles before publishing a timetable that references them. Published profile updates can change displayed names/specialties; keeping full profile history is a future enhancement.

The future authenticated Clinic Admin layer will manage drafts, validate references, set publication timestamps and audit the authorized publisher. This stage supplies the storage and read resolution, with **no schedule-writing HTTP endpoints**. GET requests perform no writes.

## Repeatable seed and superseded records

The initial seed inserts 16 doctor profiles, 3 specialist profiles and one published weekly timetable. Stable IDs plus `$setOnInsert` protect existing records during partial-run recovery. Once the completion marker exists, reruns do no initialization writes, so later admin edits or removals are preserved. The reader never uses seed constants as fallback data.

The earlier 12 records remain untouched in `public_schedule_days`. Their exact IDs are listed in `apps/api/src/legacy-schedule-records.js`; the seed reports which are present. The live API never reads that collection, so those records cannot affect Home or Schedule. No collections are deleted.

To inspect MongoDB, use the database selected by `MONGODB_DB_NAME` and view `doctor_profiles`, `specialist_profiles`, `weekly_schedules`, `schedule_date_changes` and `schedule_seed_runs`. The baseline timetable ID is `cedar:weekly:approved-v1`.

## Checks

```powershell
npm test
npm run test --workspace @medical-center/web
npm run build
git diff --check
```

Tests cover recurring weekdays, Saturday hours, Sunday closure, appointment-required flags, protected seed reruns, date overrides/cancellations, future publications, hidden drafts, isolated old records, Beirut dates, validation and read-only HTTP behavior. Date-change and future-admin tests use synthetic fixtures.

Frontend tests cover all 14 supplied specialty icons, ENT aliases, the display-only Therapist label, and an unknown-specialty fallback. Icon source/redistribution licensing remains unverified; see `apps/web/src/assets/specialties/README.md`. The dedicated Doctors page is not implemented yet: Our Doctors currently links to the Home section.

## Intended scope

The planned system includes public pages, full-doctor-session booking with shared online/receptionist capacity once confirmed, an FCFS check-in queue, staff-approved extra walk-ins, patient access to approved lab PDFs, and separate clinic/lab reception workflows. Development messaging uses mock/synthetic delivery; live WhatsApp requires authorized integration access. No online lab booking, online payment, pharmacy, insurance, AI chatbot or electronic doctor notes are planned for the first version.
