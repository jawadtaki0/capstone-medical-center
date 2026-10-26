// Shared vocabulary, not client authority. The API checks current records.
export const STAFF_ROLE_POLICY = "four-roles-v1";
export function assertCompatibleRolePolicy(value) {
  if (value !== STAFF_ROLE_POLICY)
    throw Object.assign(
      new Error(
        "This staff application requires the matching four-role staff API. Complete the coordinated maintenance cutover before using this package.",
      ),
      { code: "role_policy_mismatch" },
    );
}
export const ROLES = Object.freeze([
  "Admin",
  "Clinic Admin",
  "Lab Admin",
  "Receptionist",
]);
const MFA_ROLES = new Set(["Admin", "Clinic Admin", "Lab Admin"]);
export function validRoles(roles) {
  return (
    Array.isArray(roles) &&
    roles.length > 0 &&
    new Set(roles).size === roles.length &&
    roles.every((role) => ROLES.includes(role))
  );
}
export function requiresMfa(roles) {
  return validRoles(roles) && roles.some((role) => MFA_ROLES.has(role));
}
