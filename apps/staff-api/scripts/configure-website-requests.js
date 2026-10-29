import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { provisionRequestConfig } from "../src/request-integration.js";
// Only new purpose-specific secrets are generated, never displayed/reused/reset.
const prompt = createInterface({ input: stdin, output: stdout });
try {
  const confirmation = await prompt.question(
    "This provisions dedicated local intake configuration; it does not activate services. Type CONFIGURE LOCAL REQUESTS: ",
  );
  if (confirmation !== "CONFIGURE LOCAL REQUESTS")
    throw Error("Cancelled; no configuration changed.");
  const contact = await prompt.question(
    "Approved public center contact (not a personal secret): ",
  );
  await provisionRequestConfig({
    contact,
    publicBase: "http://localhost:5173",
    confirmed: true,
  });
  console.log(
    "Protected local request configuration created. Services and public intake were not activated.",
  );
} catch {
  console.error(
    "Request configuration was not completed. Existing settings were not replaced.",
  );
  process.exitCode = 1;
} finally {
  prompt.close();
}
