export const ROLES = Object.freeze([
  "Admin",
  "System Admin",
  "Clinic Admin",
  "Lab Admin",
  "Clinic Receptionist",
  "Lab Receptionist",
]);
const adminRoles = new Set(ROLES.slice(0, 4));

export function validRoles(roles) {
  return (
    Array.isArray(roles) &&
    roles.length > 0 &&
    new Set(roles).size === roles.length &&
    roles.every((role) => ROLES.includes(role))
  );
}

export function requiresMfa(roles) {
  return validRoles(roles) && roles.some((role) => adminRoles.has(role));
}

// Departments are deliberately absent. UI permission labels are not authority:
// each endpoint rechecks the current actor and the requested target operation.
export function permissionsFor(roles) {
  if (!validRoles(roles)) return [];
  const permissions = [
    "workspace:view",
    "profile:own:view",
    "profile:own:contact",
  ];
  if (roles.some((role) => ["Admin", "System Admin"].includes(role))) {
    permissions.push("staff:directory", "staff:profiles", "staff:manage");
  }
  if (roles.includes("Admin")) permissions.push("staff:protected:manage");
  return permissions;
}

export function hasPermission(roles, permission) {
  return permissionsFor(roles).includes(permission);
}
