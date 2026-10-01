import { getDatabase } from "./db.js";
import { COLLECTIONS } from "./schedule-model.js";

const PUBLIC_PROJECTION = Object.freeze({ _id: 1, name: 1, specialty: 1, gender: 1 });

function publicProfile(profile, kind) {
  const id = profile._id;
  if (typeof id !== "string" || !id.trim()
    || typeof profile.name !== "string" || !profile.name.trim()
    || typeof profile.specialty !== "string" || !profile.specialty.trim()) {
    throw new Error("An eligible public professional has invalid directory fields.");
  }

  const avatarVariant = ["male", "female"].includes(profile.gender) ? profile.gender : "neutral";
  // Keep a second allowlist at the DTO boundary; raw gender and internal fields stay private.
  return { id, name: profile.name, specialty: profile.specialty, kind, avatarVariant };
}

// Independent of sessions: an eligible professional remains listed on days off.
// No seeding, publication, indexes, or other database writes happen on this path.
export async function getPublicProfessionals(database = undefined) {
  const db = database ?? getDatabase();
  const readProfiles = async (collection, kind) => {
    const profiles = await db.collection(collection).find(
      { active: true }, { projection: PUBLIC_PROJECTION },
    ).toArray();
    return profiles.map((profile) => publicProfile(profile, kind));
  };
  const groups = await Promise.all([
    readProfiles(COLLECTIONS.doctors, "doctor"),
    readProfiles(COLLECTIONS.specialists, "specialist"),
  ]);
  const professionals = groups.flat().sort((first, second) => (
    first.name.localeCompare(second.name, "en", { sensitivity: "base" })
    || first.id.localeCompare(second.id, "en")
  ));
  if (new Set(professionals.map(({ id }) => id)).size !== professionals.length) {
    throw new Error("Public professional identifiers must be unique.");
  }
  return { professionals };
}
