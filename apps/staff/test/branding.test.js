import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { launcherIcon } from "../../staff-api/scripts/launcher/icon.js";

test("Cedar cross ICO provides transparent blue-and-white Windows sizes", () => {
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
    assert.equal(icon.readInt32LE(offset + 4), size);
    assert.equal(icon.readInt32LE(offset + 8), size * 2);
    const pixel = (x, y) => [
      ...icon.subarray(
        offset + 40 + ((size - 1 - y) * size + x) * 4,
        offset + 40 + ((size - 1 - y) * size + x) * 4 + 4,
      ),
    ];
    assert.equal(pixel(0, 0)[3], 0);
    assert.deepEqual(
      pixel(Math.floor(size / 2), Math.floor(size / 2)),
      [255, 255, 255, 255],
    );
    assert.deepEqual(
      pixel(Math.floor(size / 4), Math.floor(size / 4)),
      [158, 116, 0, 255],
    );
    end += length;
  }
  assert.equal(end, icon.length);
});

test("packaged local artwork matches shortcut artwork and is configured without signing", async () => {
  const icon = await readFile(
    new URL("../assets/cedar-staff.ico", import.meta.url),
  );
  assert.deepEqual(icon, launcherIcon());
  const config = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(config.build.win.icon, "assets/cedar-staff.ico");
  assert.equal(config.build.win.signExecutable, false);
  assert.notEqual(config.build.win.signAndEditExecutable, false);
  assert.ok(config.build.files.includes("assets/**/*"));
});
