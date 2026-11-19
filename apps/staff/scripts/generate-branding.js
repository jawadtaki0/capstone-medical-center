import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../assets/cedar-staff.ico", import.meta.url),
  new URL("../../web/public/favicon.ico", import.meta.url),
);
console.log("Synced the approved Cedar symbol ICO to the website favicon.");
