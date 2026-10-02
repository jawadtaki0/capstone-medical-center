export const ROLES = Object.freeze([
  "Admin", "System Admin", "Clinic Admin", "Lab Admin", "Clinic Receptionist", "Lab Receptionist",
]);
const adminRoles = new Set(ROLES.slice(0, 4));

export function validRoles(roles) {
  return Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length
    && roles.every((role) => ROLES.includes(role));
}

export function requiresMfa(roles) {
  return validRoles(roles) && roles.some((role) => adminRoles.has(role));
}

// This increment grants only the working foundation. Future role-specific
// operations do not acquire endpoints or permissions merely from a sidebar.
export function permissionsFor(roles) {
  return validRoles(roles) ? ["workspace:view"] : [];
}

export function hasPermission(roles, permission) {
  return permissionsFor(roles).includes(permission);
}
