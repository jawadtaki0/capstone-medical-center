import { readFileSync } from "node:fs";

export function launcherIcon() {
  return readFileSync(
    new URL("../../../staff/assets/cedar-staff.ico", import.meta.url),
  );
}
