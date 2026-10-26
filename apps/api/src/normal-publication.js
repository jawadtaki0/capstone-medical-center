import {
  loadPublicationConfig,
  publicationEnvironment,
} from "../../staff-api/src/publication-config.js";
import { createPublicationReceiver } from "./publication-receiver.js";
import { createPublicAuthority } from "./public-authority.js";

export async function assertLegacyReaderMode(db) {
  const authority = await db
    .collection("public_data_authority")
    .findOne({ _id: "source" });
  if (authority && authority.mode !== "legacy")
    throw new Error(
      "Cedar source requires its explicit publication configuration. Legacy fallback is refused.",
    );
}

// Explicit startup selection enables a staged receiver, NOT a reader cutover.
// The persistent authority record decides reader mode on each request.
export async function normalPublicationReaders(
  db,
  { enabled = false, load = loadPublicationConfig } = {},
) {
  if (!enabled) return null;
  const config = await load();
  if (!config)
    throw new Error(
      "Configure private publication delivery before enabling the normal receiver.",
    );
  const receiver = await createPublicationReceiver({
    db,
    client: db.client,
    token: config.token,
    streamId: config.streamId,
    demoMode: true,
    environment: publicationEnvironment(config),
  });
  return {
    receiver,
    authority: createPublicAuthority({
      db,
      client: db.client,
      streamId: config.streamId,
    }),
  };
}
