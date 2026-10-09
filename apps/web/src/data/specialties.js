// Static URLs let Vite package the supplied assets; no Downloads path is used at runtime.
export const specialtyDefinitions = [
  {
    id: "pediatrics",
    label: "Pediatrics, Neonatology, and General Health",
    aliases: ["Pediatrics, Neonatology, and General Health"],
    asset: new URL("../assets/specialties/pediatric.png", import.meta.url).href,
    size: 26,
  },
  {
    id: "dentistry",
    label: "Dentistry",
    aliases: ["Dentistry", "Dentist"],
    asset: new URL("../assets/specialties/tooth-24px.svg", import.meta.url)
      .href,
    size: 24,
  },
  {
    id: "cardiology",
    label: "Cardiology",
    aliases: ["Cardiology", "Cardiologist"],
    asset: new URL(
      "../assets/specialties/heart-organ-24px.svg",
      import.meta.url,
    ).href,
    size: 24,
  },
  {
    id: "urology",
    label: "Urology",
    aliases: ["Urology", "Urologist"],
    asset: new URL("../assets/specialties/bladder-24px.svg", import.meta.url)
      .href,
    size: 24,
  },
  {
    id: "ent",
    label: "ENT",
    aliases: ["ENT", "ENT (Otolaryngology)", "Otolaryngology"],
    asset: new URL("../assets/specialties/ear-24px.svg", import.meta.url).href,
    size: 24,
  },
  {
    id: "ophthalmology",
    label: "Ophthalmology & Eye Surgery",
    aliases: ["Ophthalmology & Eye Surgery", "Ophthalmology"],
    asset: new URL("../assets/specialties/eye-24px.svg", import.meta.url).href,
    size: 24,
  },
  {
    id: "gynecology",
    label: "Gynecology",
    aliases: ["Gynecology", "Gynecologist"],
    asset: new URL(
      "../assets/specialties/female-reproductive_system-24px.svg",
      import.meta.url,
    ).href,
    size: 24,
  },
  {
    id: "gastroenterology",
    label: "Gastroenterology",
    aliases: ["Gastroenterology", "Gastroenterologist", "Gastreonterologist"],
    asset: new URL("../assets/specialties/stomach.svg", import.meta.url).href,
    size: 26,
  },
  {
    id: "endocrinology",
    label: "Endocrinology & Diabetes",
    aliases: ["Endocrinology & Diabetes"],
    asset: new URL("../assets/specialties/glucosemeter.png", import.meta.url)
      .href,
    size: 25,
  },
  {
    id: "dietitian",
    label: "Dietitian",
    aliases: ["Dietitian"],
    asset: new URL("../assets/specialties/food.png", import.meta.url).href,
    size: 25,
  },
  {
    id: "therapist",
    label: "Therapist",
    aliases: [
      "Therapist",
      "Psychological & Behavioral Specialist (Therapist)",
      "Psychological & Behavioral Specialist",
    ],
    asset: new URL("../assets/specialties/talk.png", import.meta.url).href,
    size: 25,
  },
  {
    id: "speech-therapy",
    label: "Speech, Language, and Swallowing Therapist",
    aliases: ["Speech, Language, and Swallowing Therapist"],
    asset: new URL("../assets/specialties/speech-therapy.png", import.meta.url)
      .href,
    size: 26,
  },
  {
    id: "dermatology",
    label: "Dermatology",
    aliases: ["Dermatology", "Dermatologist"],
    asset: new URL("../assets/specialties/dermatology.png", import.meta.url)
      .href,
    size: 25,
  },
  {
    id: "surgery",
    label: "General Surgery",
    aliases: ["General Surgery"],
    asset: new URL("../assets/specialties/surgery.png", import.meta.url).href,
    size: 26,
  },
];

function normalizeSpecialty(value) {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\s+/g, " ")
        .replace(/\s*\(\s*/g, " (")
        .replace(/\s*\)/g, ")")
    : "";
}

const byAlias = new Map(
  specialtyDefinitions.flatMap((definition) =>
    definition.aliases.map((alias) => [normalizeSpecialty(alias), definition]),
  ),
);

export function getSpecialtyIcon(specialty) {
  return (
    byAlias.get(normalizeSpecialty(specialty)) ?? {
      id: "medical",
      asset: null,
      size: 24,
    }
  );
}

export function specialtyLabel(specialty) {
  // Only the requested Therapist label changes; all other API wording stays visible.
  if (getSpecialtyIcon(specialty).id === "therapist") return "Therapist";
  return typeof specialty === "string" && specialty.trim()
    ? specialty.trim()
    : "Medical care";
}
