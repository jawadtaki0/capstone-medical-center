import { getSpecialtyIcon, specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";
import { normalizeAvatarVariant } from "../data/professionalAvatars.js";

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseDirectoryResponse(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.professionals)
  ) {
    throw new Error("The professional directory response is invalid.");
  }

  const seenIds = new Set();
  return payload.professionals.map((professional) => {
    if (
      !professional ||
      typeof professional !== "object" ||
      !isNonemptyString(professional.id) ||
      !isNonemptyString(professional.name) ||
      !isNonemptyString(professional.specialty) ||
      !["doctor", "specialist"].includes(professional.kind) ||
      seenIds.has(professional.id)
    ) {
      throw new Error(
        "The professional directory contains an invalid or duplicate profile.",
      );
    }

    seenIds.add(professional.id);
    // Keep the public contract small even if the server adds other fields later.
    return {
      id: professional.id,
      name: professional.name,
      specialty: professional.specialty,
      kind: professional.kind,
      avatarVariant: normalizeAvatarVariant(professional.avatarVariant),
    };
  });
}

function normalizeSearch(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

export function filterProfessionals(professionals, query = "") {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return professionals;

  return professionals.filter((professional) =>
    [
      professional.name,
      professionalName(professional.name),
      professional.specialty,
      specialtyLabel(professional.specialty),
      // Include known wording variants even if a profile stores the short label.
      ...(getSpecialtyIcon(professional.specialty).aliases ?? []),
    ].some((value) => normalizeSearch(value).includes(normalizedQuery)),
  );
}
