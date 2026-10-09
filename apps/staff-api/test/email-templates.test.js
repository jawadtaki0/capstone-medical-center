import assert from "node:assert/strict";
import { test } from "node:test";
import {
  verificationEmail,
  emailChangedNotification,
  escapeHtml,
} from "../src/email-templates.js";

const expiresAt = new Date("2026-10-05T15:10:00.000Z");

test("verification HTML and text share the code, instructions, original Beirut deadline and safety notes", () => {
  const message = verificationEmail({ code: "00123456", expiresAt });
  assert.equal(message.subject, "Verify your email — Cedar Staff");
  for (const content of [message.html, message.text]) {
    for (const phrase of [
      "Verify your email address",
      "00123456",
      "Enter this code in the Cedar Staff application",
      "5 October 2026 at 18:10:00 (Asia/Beirut)",
      "Resending does not extend this deadline.",
      "Do not share this code.",
      "If you did not request verification, ignore this message.",
    ])
      assert.ok(content.includes(phrase), phrase);
  }
  assert.doesNotMatch(message.subject, /00123456/);
  const preheader = message.html.match(
    /<!-- Preview text -->\s*<div[^>]*>([\s\S]*?)<\/div>/,
  )[1];
  assert.doesNotMatch(preheader, /00123456/);
  assert.match(message.html, /user-select: text/);
});

test("resend rendering uses the supplied expiry, never the current clock or a new ten-minute deadline", () => {
  const original = verificationEmail({ code: "00123456", expiresAt });
  const resend = verificationEmail({
    code: "00987654",
    expiresAt: new Date(expiresAt),
  });
  assert.ok(original.text.includes("5 October 2026 at 18:10:00"));
  assert.ok(resend.text.includes("5 October 2026 at 18:10:00"));
  assert.ok(resend.text.includes("00987654"));
  assert.doesNotMatch(resend.text, /00123456|ten minutes|10 minutes/i);
  const earlier = verificationEmail({
    code: "00000001",
    expiresAt: new Date("2026-10-05T15:02:00Z"),
  });
  assert.ok(earlier.text.includes("18:02:00"));
});

test("missing or invalid optional expiry never invents a deadline", () => {
  for (const expiry of [undefined, new Date("invalid")]) {
    const message = verificationEmail({ code: "00123456", expiresAt: expiry });
    assert.ok(
      message.text.includes("Check the application for this request's expiry."),
    );
    assert.doesNotMatch(message.text, /Invalid Date|10 minutes|2026/);
  }
});

test("dynamic HTML is escaped without changing the plain-text value", () => {
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  const code = '<img src="external" onerror="bad">&';
  const message = verificationEmail({ code, expiresAt });
  assert.ok(message.html.includes(escapeHtml(code)));
  assert.doesNotMatch(message.html, /<img|onerror="bad"/);
  assert.ok(message.text.includes(code));
});

test("notification has equivalent safe content and no code, support address or recovery link", () => {
  const message = emailChangedNotification();
  for (const content of [message.html, message.text]) {
    assert.ok(content.includes("Your email address was changed"));
    assert.ok(
      content.includes(
        "If you do not recognize this change, report it to an authorized administrator.",
      ),
    );
    assert.doesNotMatch(
      content,
      /verification code|\d{8}|@|https?:|recovery|password/i,
    );
  }
});

test("both templates use responsive inline styling without external resources or tracking", () => {
  for (const message of [
    verificationEmail({ code: "00123456", expiresAt }),
    emailChangedNotification(),
  ]) {
    assert.match(message.html, /<html lang="en">/);
    assert.match(message.html, /name="viewport"/);
    assert.match(message.html, /max-width: 560px/);
    assert.match(message.html, /role="presentation"/);
    assert.doesNotMatch(
      message.html,
      /<(?:script|style|img|link|iframe|a)\b|https?:\/\/|animation|@import/i,
    );
    assert.equal((message.html.match(/<h1\b/g) ?? []).length, 1);
  }
});
