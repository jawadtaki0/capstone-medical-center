import { assistantReviewPlugin } from "./server/assistant-review.js";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Only served by Vite development middleware; excluded from production assets.
function localPrototypePhoto() {
  const photo = fileURLToPath(
    new URL("./local-assets/hero.png", import.meta.url),
  );
  return {
    name: "local-prototype-photo",
    configureServer(server) {
      server.middlewares.use("/__prototype/hero.png", (_request, response) => {
        if (!existsSync(photo)) {
          response.writeHead(204).end();
          return;
        }
        response.setHeader("Content-Type", "image/png");
        response.setHeader("Cache-Control", "no-store");
        const stream = createReadStream(photo);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    localPrototypePhoto(),
    ...(process.env.CEDAR_ASSISTANT_ISOLATED_REVIEW === "1"
      ? [
          assistantReviewPlugin({
            realModel: process.env.CEDAR_ASSISTANT_REVIEW_GEMINI === "1",
          }),
        ]
      : []),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
