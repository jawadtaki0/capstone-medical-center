import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { launcherIcon } from "../../staff-api/scripts/launcher/icon.js";

test("Cedar symbol ICO provides an RGBA PNG at each Windows icon size", () => {
  const icon = launcherIcon();
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), sizes.length);
  let end = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(icon[entry] || 256, size);
    assert.equal(icon[entry + 1] || 256, size);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    assert.equal(offset, end);
    assert.equal(
      icon.subarray(offset, offset + 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    assert.equal(icon.readUInt32BE(offset + 16), size);
    assert.equal(icon.readUInt32BE(offset + 20), size);
    assert.equal(icon[offset + 25], 6);
    end += length;
  }
  assert.equal(end, icon.length);
});

test("packaged local artwork matches shortcut artwork and is configured without signing", async () => {
  const icon = await readFile(
    new URL("../assets/cedar-staff.ico", import.meta.url),
  );
  assert.deepEqual(icon, launcherIcon());
  assert.deepEqual(
    icon,
    await readFile(new URL("../../web/public/favicon.ico", import.meta.url)),
  );
  const config = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(config.build.win.icon, "assets/cedar-staff.ico");
  assert.equal(config.build.win.signExecutable, false);
  assert.notEqual(config.build.win.signAndEditExecutable, false);
  assert.ok(config.build.files.includes("assets/**/*"));
});
