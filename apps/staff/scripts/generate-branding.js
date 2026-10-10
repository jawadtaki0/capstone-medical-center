import { mkdir, writeFile } from "node:fs/promises";
import { launcherIcon } from "../../staff-api/scripts/launcher/icon.js";

// Build-time only; the desktop runtime uses the bundled artwork, not the API.
const assets = new URL("../assets/", import.meta.url);
await mkdir(assets, { recursive: true });
await writeFile(new URL("cedar-staff.ico", assets), launcherIcon());
console.log("Generated local Cedar cross ICO: 16/24/32/48/64/128/256px.");
