import { setTimeout } from "node:timers/promises";
import { geminiAssistant } from "../server/public-assistant.js";

let previous = Date.now();
export function liveGemini(observe, measure) {
  return geminiAssistant({
    key: process.env.GEMINI_API_KEY,
    model: process.env.CEDAR_GEMINI_MODEL,
    observe,
    measure,
    async beforeAttempt(deadline) {
      const wait = Math.max(0, previous + 7000 - Date.now());
      await setTimeout(Math.min(wait, Math.max(0, deadline - Date.now())));
      if (deadline - Date.now() >= 500) previous = Date.now();
    },
  });
}
