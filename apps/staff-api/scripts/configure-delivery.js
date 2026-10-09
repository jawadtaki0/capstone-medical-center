import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExistingAuthority,
  enableStaffSelfService,
  loadDeliveryConfig,
  normalizeEmail,
  saveDeliveryConfig,
} from "../src/contact-delivery.js";
import { privateEntry, PrivateFormError } from "./private-delivery-form.js";
export { privateEntry } from "./private-delivery-form.js";

async function run() {
  if (process.platform !== "win32" || !process.argv.includes("--demo-loopback"))
    throw new Error("Explicit Windows local demo required.");
  const checkOnly = process.argv.includes("--check-form");
  if (checkOnly) {
    console.log(
      "Popup check only: no credentials, configuration or database are read or saved. Click Cancel, press Escape, or close X.",
    );
    await privateEntry(false, {
      checkOnly,
      onReady: () =>
        console.log(
          "Private popup reports open. No saving is possible in this check.",
        ),
    });
    console.log("Popup check cancelled successfully. Nothing changed.");
    return;
  }
  await assertExistingAuthority();
  if (process.argv.includes("--approve-sending")) {
    console.error(
      "Recipient-list setup has been retired. Use --enable-self-service for one center-wide confirmation; the existing allowance and usage will not change.",
    );
    process.exitCode = 1;
    return;
  }
  const approval = process.argv.includes("--enable-self-service");
  let existing;
  try {
    existing = await loadDeliveryConfig();
  } catch (error) {
    // Never overwrite unreadable protected settings or grant a new allowance.
    if (error.code !== "ENOENT") throw error;
  }
  if (approval && (!existing?.allowance || !existing.approvalId)) {
    console.error(
      "No existing approved allowance is available. This tool cannot create or replenish it. Review the center-wide sending allowance before activation.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "Opening private entry. Cancel/Escape/X saves nothing; Ctrl+C stops only this tool. No message will be sent.",
  );
  const values = await privateEntry(approval, {
    onReady: () =>
      console.log(
        "Private form reports open. If obscured, use Alt+Tab to find Private Cedar Staff delivery setup.",
      ),
  });
  if (!values) {
    console.log("Cancelled. No delivery configuration changed.");
    return;
  }
  let config;
  if (approval) {
    config = enableStaffSelfService(existing);
  } else {
    config = {
      version: 2,
      deliveryScope: "staff_self_service",
      provider: "gmail",
      sender: normalizeEmail(values[0]),
      appPassword: values[1].replaceAll(" ", ""),
      enabled: false,
      allowance: existing?.allowance ?? 0,
      approvalId: existing?.approvalId ?? null,
    };
  }
  await saveDeliveryConfig(config);
  values.fill("");
  config.appPassword = "";
  console.log(
    approval
      ? "Staff self-service email enabled privately for the center. Existing allowance and usage identity unchanged. No provider connection or message attempted. Monthly ceiling remains 20."
      : "Credentials saved encrypted. Sending remains OFF. No provider connection or message attempted.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((error) => {
    console.error(
      error instanceof PrivateFormError
        ? error.message
        : "Delivery setup failed safely. Check private inputs and the existing runtime-folder setting; do not recreate keys. No credential details are printed.",
    );
    process.exitCode =
      error instanceof PrivateFormError && error.code === "interrupted"
        ? 130
        : 1;
  });
}
