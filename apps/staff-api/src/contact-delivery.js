import nodemailer from "nodemailer";
import {
  verificationEmail,
  emailChangedNotification,
  recoveryEmail,
  recoveryNotification,
} from "./email-templates.js";
import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dpapi, protectDirectory, runtimeDirectory } from "./local-security.js";
import { StaffError } from "./errors.js";
import {
  normalizedEmail,
  EMAIL_INPUT_MESSAGE,
} from "../../staff/shared/contact-input.js";

export function normalizeEmail(value) {
  const email = normalizedEmail(value);
  if (!email) throw new StaffError("invalid_input", EMAIL_INPUT_MESSAGE);
  return email;
}
export function validateDeliveryConfig(value) {
  if (
    ![1, 2].includes(value?.version) ||
    value.provider !== "gmail" ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("Invalid delivery configuration.");
  const sender = normalizeEmail(value.sender);
  if (
    !sender.endsWith("@gmail.com") ||
    typeof value.appPassword !== "string" ||
    !/^[A-Za-z0-9]{16}$/.test(value.appPassword)
  )
    throw new Error("Use the dedicated Gmail app password.");
  if (value.version === 2 && value.deliveryScope !== "staff_self_service")
    throw new Error("Invalid delivery scope.");
  if (
    !Number.isInteger(value.allowance) ||
    value.allowance < 0 ||
    value.allowance > 20 ||
    (value.enabled &&
      (!value.allowance || !/^[a-f0-9-]{36}$/.test(value.approvalId)))
  )
    throw new Error("An approved sending allowance is required.");
  return {
    version: value.version,
    provider: "gmail",
    sender,
    appPassword: value.appPassword,
    enabled: value.enabled,
    ...(value.version === 2 ? { deliveryScope: "staff_self_service" } : {}),
    allowance: value.allowance,
    approvalId: value.approvalId ?? null,
  };
}
export function enableStaffSelfService(value) {
  const existing = validateDeliveryConfig(value);
  if (!existing.allowance || !/^[a-f0-9-]{36}$/.test(existing.approvalId ?? ""))
    throw new Error(
      "An existing approved allowance is required; this operation cannot create or replenish it.",
    );
  return validateDeliveryConfig({
    ...existing,
    version: 2,
    deliveryScope: "staff_self_service",
    enabled: true,
  });
}

export const DELIVERY_MESSAGES = Object.freeze({
  contact_delivery_not_configured:
    "The center email sender is not configured or could not be loaded. Ask the operator to check its private setup.",
  contact_delivery_disabled:
    "Email delivery is disabled by the center operator. Your saved email has not changed.",
  contact_delivery_activation_required:
    "Staff self-service email delivery needs a one-time operator activation. No employee recipient list is required.",
  contact_sending_limit:
    "The existing sending allowance or monthly email limit is exhausted. Your saved email has not changed; the allowance will not be replenished automatically.",
  contact_delivery_failed:
    "The email provider could not confirm delivery. Check internet/provider availability before retrying. Your saved email has not changed.",
});
export function safeDeliveryError(error) {
  const code = Object.hasOwn(DELIVERY_MESSAGES, error?.code ?? "")
    ? error.code
    : "contact_delivery_failed";
  return new StaffError(
    code,
    DELIVERY_MESSAGES[code],
    code === "contact_sending_limit"
      ? 429
      : code === "contact_delivery_failed"
        ? 502
        : 409,
  );
}
export async function loadDeliveryConfig({
  directory = join(runtimeDirectory, "delivery"),
  unwrap = (value) => dpapi(value, "Unprotect"),
} = {}) {
  const wrapped = await readFile(join(directory, "gmail.dpapi"));
  const plain = await unwrap(wrapped);
  try {
    return validateDeliveryConfig(JSON.parse(plain.toString("utf8")));
  } finally {
    plain.fill(0);
  }
}

async function withDeliveryLock(directory, action) {
  const lockPath = join(directory, "gmail.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST")
      throw new StaffError(
        "delivery_configuration_busy",
        "Another delivery configuration operation is in progress. Nothing changed; retry after it finishes. Do not remove its lock.",
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
}

async function writeDeliveryFile(value, directory, wrap) {
  const pending = join(directory, `gmail-${randomUUID()}.pending.dpapi`);
  try {
    const plain = Buffer.from(JSON.stringify(value));
    try {
      await writeFile(pending, await wrap(plain), { flag: "wx", flush: true });
    } finally {
      plain.fill(0);
    }
    await rename(pending, join(directory, "gmail.dpapi"));
  } finally {
    await unlink(pending).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const configurationChanged = () =>
  new StaffError(
    "delivery_configuration_changed",
    "Delivery settings changed since this operation was approved. Nothing was saved; check the current total and confirm again.",
  );

// Local operator only. No database, budget reset, provider call or activation.
// Read under the same exclusive lock as credential/activation writes and retain
// the raw configuration so unrelated/legacy settings are not normalized away.
export async function increaseDeliveryAllowance(
  input,
  {
    directory = join(runtimeDirectory, "delivery"),
    wrap = (value) => dpapi(value, "Protect"),
    unwrap = (value) => dpapi(value, "Unprotect"),
  } = {},
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !["expectedAllowance", "newAllowance", "confirmation"].includes(key),
    ) ||
    !Number.isInteger(input.expectedAllowance) ||
    input.expectedAllowance < 1 ||
    !Number.isInteger(input.newAllowance) ||
    input.newAllowance <= input.expectedAllowance ||
    input.newAllowance > 20 ||
    input.confirmation !==
      `INCREASE ${input.expectedAllowance} TO ${input.newAllowance}`
  )
    throw new StaffError(
      "delivery_allowance_input",
      "Confirm an increase from the expected current total to a whole-number total no greater than 20. Decreases, resets and unrelated changes are not allowed.",
    );
  return withDeliveryLock(directory, async () => {
    const plain = await unwrap(await readFile(join(directory, "gmail.dpapi")));
    let existing;
    try {
      existing = JSON.parse(plain.toString("utf8"));
      const checked = validateDeliveryConfig(existing);
      if (
        !checked.allowance ||
        !/^[a-f0-9-]{36}$/.test(checked.approvalId ?? "")
      )
        throw new StaffError(
          "delivery_allowance_missing",
          "An existing approved budget identity is required. No configuration was created or replaced.",
        );
      if (checked.allowance !== input.expectedAllowance)
        throw configurationChanged();
      await writeDeliveryFile(
        { ...existing, allowance: input.newAllowance },
        directory,
        wrap,
      );
      return {
        previousAllowance: checked.allowance,
        allowance: input.newAllowance,
      };
    } finally {
      plain.fill(0);
      existing = undefined;
    }
  });
}

export async function saveDeliveryConfig(
  value,
  {
    directory = join(runtimeDirectory, "delivery"),
    wrap = (data) => dpapi(data, "Protect"),
    unwrap = (data) => dpapi(data, "Unprotect"),
    prepare = protectDirectory,
    expectedConfig,
  } = {},
) {
  const config = validateDeliveryConfig(value);
  await prepare(directory);
  await withDeliveryLock(directory, async () => {
    // Operator forms capture settings before user entry. Refuse stale saves so
    // a concurrent allowance increase cannot be undone by that old snapshot.
    if (expectedConfig !== undefined) {
      let current = null;
      try {
        current = await loadDeliveryConfig({ directory, unwrap });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        JSON.stringify(current) !==
        JSON.stringify(
          expectedConfig === null
            ? null
            : validateDeliveryConfig(expectedConfig),
        )
      )
        throw configurationChanged();
    }
    await writeDeliveryFile(config, directory, wrap);
  });
}
export async function assertExistingAuthority() {
  // Never prepare/bootstrap or replace existing protected authority material.
  await access(join(runtimeDirectory, "authority.dpapi"));
}
export function createGmailDelivery({
  load = loadDeliveryConfig,
  transport = nodemailer.createTransport,
} = {}) {
  return {
    mode: "live",
    provider: "gmail",
    async configuration(destination) {
      let config;
      try {
        config = validateDeliveryConfig(await load());
      } catch {
        throw safeDeliveryError({ code: "contact_delivery_not_configured" });
      }
      if (!config.enabled)
        throw safeDeliveryError({ code: "contact_delivery_disabled" });
      if (config.version !== 2)
        throw safeDeliveryError({
          code: "contact_delivery_activation_required",
        });
      if (destination !== undefined) normalizeEmail(destination);
      return config;
    },
    async send({
      destination,
      code,
      expiresAt,
      notification = false,
      purpose,
    }) {
      destination = normalizeEmail(destination);
      const config = await this.configuration(destination);
      let smtp;
      try {
        const message =
          purpose === "recovery"
            ? recoveryEmail({ code, expiresAt })
            : purpose === "recovery_notice"
              ? recoveryNotification()
              : notification
                ? emailChangedNotification()
                : verificationEmail({ code, expiresAt });
        smtp = transport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          auth: { user: config.sender, pass: config.appPassword },
          tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
          name: "[127.0.0.1]",
          logger: false,
          debug: false,
          transactionLog: false,
          disableFileAccess: true,
          disableUrlAccess: true,
          maxRecipients: 1,
          connectionTimeout: 4000,
          greetingTimeout: 4000,
          socketTimeout: 4000,
          dnsTimeout: 4000,
        });
        const result = await smtp.sendMail({
          from: config.sender,
          to: destination,
          ...message,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        if (
          !result.accepted?.some(
            (value) => String(value).toLowerCase() === destination,
          ) ||
          result.rejected?.length
        )
          throw new Error("Delivery not accepted.");
      } catch {
        throw safeDeliveryError({ code: "contact_delivery_failed" });
      } finally {
        try {
          smtp?.close();
        } catch {
          /* Never expose provider cleanup details. */
        }
      }
    },
  };
}
