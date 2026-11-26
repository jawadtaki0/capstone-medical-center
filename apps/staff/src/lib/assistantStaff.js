import { TEXT } from "../components/assistantText.js";

const NAMED = [
  ["Clinic Admin", /clinic admin(istrator)?|(مدير|ادمن|أدمن) العيادة/],
  ["Lab Admin", /lab(oratory)? admin(istrator)?|(مدير|ادمن|أدمن) المختبر/],
  ["Receptionist", /reception(ist)?|استقبال/],
];

// Pre-ticks only; the manager chooses, and the server checks the roles.
export function readRoles(message) {
  let text = message.toLowerCase();
  const found = NAMED.filter(([, pattern]) => pattern.test(text)).map(
    ([role]) => role,
  );
  for (const [, pattern] of NAMED) text = text.replace(pattern, " ");
  // "admin" alone, not part of another role and not the verb "add".
  if (/\badmin(istrator)?\b/.test(text)) found.unshift("Admin");
  return found;
}

// What the saved chat keeps. The one-time code is never part of it.
export const createdNote = (language, result) =>
  TEXT[language].staffCreated(result.account.username);
