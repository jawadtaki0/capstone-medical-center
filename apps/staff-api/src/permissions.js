import {
  ROLES,
  validRoles,
  requiresMfa,
} from "../../../shared/staff-roles.mjs";
export { ROLES, validRoles, requiresMfa };

// Departments are deliberately absent. UI permission labels are not authority:
// each endpoint rechecks the current actor and the requested target operation.
export function permissionsFor(roles) {
  if (!validRoles(roles)) return [];
  const permissions = [
    "workspace:view",
    "profile:own:view",
    "profile:own:contact",
  ];
  if (roles.includes("Admin")) {
    permissions.push("staff:directory", "staff:profiles", "staff:manage");
  }
  if (roles.includes("Admin")) permissions.push("staff:protected:manage");
  if (
    roles.some((role) =>
      ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"].includes(role),
    )
  )
    permissions.push("operations:view");
  return permissions;
}

export function hasPermission(roles, permission) {
  return permissionsFor(roles).includes(permission);
}
