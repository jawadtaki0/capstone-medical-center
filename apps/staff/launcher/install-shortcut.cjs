const { app, shell } = require("electron");
const { readFile, writeFile, rename } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

app.whenReady().then(async () => {
  try {
    const { quoteWindowsArgument } =
      await import("../../staff-api/scripts/launcher/windows.js");
    const { projectRoot, validateLauncherConfig } =
      await import("../../staff-api/scripts/launcher/configuration.js");
    const [selection, settings, icon] = process.argv.slice(2);
    if (!selection || !settings || !icon) throw new Error();
    const config = validateLauncherConfig(
      JSON.parse(await readFile(selection, "utf8")),
    );
    const link = join(app.getPath("desktop"), "Start Cedar Staff.lnk");
    const target = join(
      projectRoot,
      "node_modules",
      "electron",
      "dist",
      "electron.exe",
    );
    const entry = join(projectRoot, "apps", "staff", "launcher", "main.js");
    if (existsSync(link)) {
      const existing = shell.readShortcutLink(link);
      if (
        resolve(existing.target).toLowerCase() !==
          resolve(target).toLowerCase() ||
        !existing.args.startsWith(quoteWindowsArgument(entry))
      )
        throw new Error();
    }
    const ok = shell.writeShortcutLink(
      link,
      existsSync(link) ? "update" : "create",
      {
        target,
        args: `${quoteWindowsArgument(entry)} --demo-loopback --config ${quoteWindowsArgument(settings)}`,
        cwd: projectRoot,
        description:
          "Check local staff services and open the selected Cedar Staff application.",
        icon,
        iconIndex: 0,
        appUserModelId: "org.capstone.cedar.launcher",
      },
    );
    if (!ok) throw new Error();
    const temporary = `${settings}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2), { flag: "wx" });
    await rename(temporary, settings);
    app.exit(0);
  } catch {
    app.exit(1);
  }
});
