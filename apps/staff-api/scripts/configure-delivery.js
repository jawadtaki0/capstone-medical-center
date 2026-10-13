import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExistingAuthority,
  enableStaffSelfService,
  increaseDeliveryAllowance,
  loadDeliveryConfig,
  normalizeEmail,
  saveDeliveryConfig,
} from "../src/contact-delivery.js";
import { privateEntry, PrivateFormError } from "./private-delivery-form.js";
import { StaffError } from "../src/errors.js";
export { privateEntry } from "./private-delivery-form.js";

export function allowanceIncreaseInput(args) {
  const flags = [
    "--increase-allowance",
    "--expected-allowance",
    "--confirm-increase",
  ];
  if (!args.some((value) => flags.includes(value))) return null;
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--demo-loopback" && !values.has(key)) {
      values.set(key, true);
      continue;
    }
    if (
      !flags.includes(key) ||
      values.has(key) ||
      typeof args[index + 1] !== "string"
    )
      throw new StaffError(
        "delivery_allowance_arguments",
        'Use only --demo-loopback, --increase-allowance TOTAL, --expected-allowance CURRENT and --confirm-increase "INCREASE CURRENT TO TOTAL". No mixed actions or usage reset.',
      );
    values.set(key, args[++index]);
  }
  const expected = values.get("--expected-allowance"),
    total = values.get("--increase-allowance");
  if (
    !values.has("--demo-loopback") ||
    !/^[1-9]\d*$/.test(expected ?? "") ||
    !/^[1-9]\d*$/.test(total ?? "") ||
    !Number.isSafeInteger(Number(expected)) ||
    !Number.isSafeInteger(Number(total)) ||
    Number(total) <= Number(expected) ||
    Number(total) > 20 ||
    values.get("--confirm-increase") !== `INCREASE ${expected} TO ${total}`
  )
    throw new StaffError(
      "delivery_allowance_arguments",
      "Explicitly confirm the expected current total and a strictly larger whole-number total no greater than 20. Nothing changed.",
    );
  return {
    expectedAllowance: Number(expected),
    newAllowance: Number(total),
    confirmation: values.get("--confirm-increase"),
  };
}

async function run() {
  if (process.platform !== "win32" || !process.argv.includes("--demo-loopback"))
    throw new Error("Explicit Windows local demo required.");
  const increase = allowanceIncreaseInput(process.argv.slice(2));
  if (increase) {
    await assertExistingAuthority();
    const result = await increaseDeliveryAllowance(increase);
    console.log(
      `Approved email allowance total increased from ${result.previousAllowance} to ${result.allowance}. Budget identity, credentials, activation and usage counters preserved. Monthly ceiling remains 20. No message sent or resend started.`,
    );
    return;
  }
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
  await saveDeliveryConfig(config, { expectedConfig: existing ?? null });
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
      error instanceof PrivateFormError || error instanceof StaffError
        ? error.message
        : "Delivery setup failed safely. Check private inputs and the existing runtime-folder setting; do not recreate keys. No credential details are printed.",
    );
    process.exitCode =
      error instanceof PrivateFormError && error.code === "interrupted"
        ? 130
        : 1;
  });
}
