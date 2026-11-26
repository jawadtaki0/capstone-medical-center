import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { statSync } from "node:fs";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dpapi, protectDirectory, runtimeDirectory } from "./local-security.js";
import {
  createGmailDelivery,
  normalizeEmail,
  safeDeliveryError,
  staffContactEmail,
} from "./contact-delivery.js";

const directory = join(runtimeDirectory, "delivery");
const credentialPath = join(directory, "ses.dpapi");
const region = "eu-north-1";
const sender = "accounts@cmc-cedar.site";
const replyTo = "contact@cmc-cedar.site";
const configurationSet = "cedar-transactional";

function validateCredentials({ accessKeyId, secretAccessKey }) {
  if (
    !/^AKIA[A-Z0-9]{16}$/.test(accessKeyId ?? "") ||
    !/^[A-Za-z0-9/+=]{40}$/.test(secretAccessKey ?? "")
  )
    throw Error("Enter the dedicated Staff IAM access key and secret.");
  return { accessKeyId, secretAccessKey };
}

async function loadCredentials() {
  const plain = await dpapi(await readFile(credentialPath), "Unprotect");
  try {
    return validateCredentials(JSON.parse(plain.toString("utf8")));
  } finally {
    plain.fill(0);
  }
}

export async function saveStaffSesCredentials(values) {
  const plain = Buffer.from(JSON.stringify(validateCredentials(values)));
  const pending = join(directory, `ses-${randomUUID()}.pending.dpapi`);
  try {
    await protectDirectory(directory);
    await writeFile(pending, await dpapi(plain, "Protect"), {
      flag: "wx",
      flush: true,
    });
    await link(pending, credentialPath);
  } finally {
    plain.fill(0);
    await unlink(pending).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function createStaffSesDelivery({
  authorization = createGmailDelivery(),
  load = loadCredentials,
  makeClient = (options) => new SESv2Client(options),
} = {}) {
  return {
    mode: "live",
    provider: "ses",
    async configuration(destination) {
      const config = await authorization.configuration(destination);
      try {
        await load();
      } catch {
        throw safeDeliveryError({ code: "contact_delivery_not_configured" });
      }
      return { approvalId: config.approvalId, allowance: config.allowance };
    },
    async send({ destination, ...fields }) {
      destination = normalizeEmail(destination);
      await this.configuration(destination);
      let client;
      try {
        client = makeClient({
          region,
          credentials: await load(),
          maxAttempts: 1,
        });
        const { subject, text, html } = staffContactEmail(fields);
        const result = await client.send(
          new SendEmailCommand({
            FromEmailAddress: `Cedar Medical Center <${sender}>`,
            ReplyToAddresses: [replyTo],
            ConfigurationSetName: configurationSet,
            Destination: { ToAddresses: [destination] },
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: {
                  Text: { Data: text, Charset: "UTF-8" },
                  Html: { Data: html, Charset: "UTF-8" },
                },
              },
            },
          }),
          { abortSignal: AbortSignal.timeout(7000) },
        );
        if (!result.MessageId) throw Error("Delivery not accepted.");
      } catch {
        throw safeDeliveryError({ code: "contact_delivery_failed" });
      } finally {
        client?.destroy();
      }
    },
  };
}

export function createStaffEmailDelivery() {
  try {
    statSync(credentialPath);
  } catch (error) {
    if (error.code === "ENOENT") return createGmailDelivery();
    throw error;
  }
  return createStaffSesDelivery();
}
