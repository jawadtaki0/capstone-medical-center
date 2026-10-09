export const STAFF_DEPARTMENTS = Object.freeze([
  "Clinic",
  "Laboratory",
  "Administration",
]);

export function suggestedUsername(firstName, lastName) {
  const normalize = (value) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return [normalize(firstName), normalize(lastName)].filter(Boolean).join(".");
}

export function setupProfile(formData) {
  const text = (key) => String(formData.get(key) ?? "").trim();
  return {
    firstName: text("firstName"),
    lastName: text("lastName"),
    fatherName: text("fatherName"),
    motherName: text("motherName"),
    dateOfBirth: text("dateOfBirth"),
    address: text("address"),
    phone: text("phone"),
    email: text("email"),
    departments: formData.getAll("departments"),
    employmentStartDate: text("employmentStartDate"),
    qualification: {
      type: "university",
      title: text("qualificationTitle"),
      institution: text("qualificationInstitution"),
    },
  };
}
