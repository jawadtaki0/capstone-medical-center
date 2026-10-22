// Harness-only automation: not bundled, exposed through IPC, or served by API.
// It fills the real password/MFA form with this fixture's generated credentials.
export async function verifySyntheticManager({ page, person, nextCode }) {
  if (
    !person?.id?.startsWith("synthetic:") ||
    !/^review\./.test(person.username)
  )
    throw new Error("Only the owned synthetic review account is permitted.");
  await page
    .getByRole("heading", {
      name: "Verify this management action",
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(person.password);
  await page
    .getByRole("button", { name: "Verify password", exact: true })
    .click();
  await page.getByLabel("Authenticator code", { exact: true }).waitFor();
  const code = await nextCode();
  await page.getByLabel("Authenticator code", { exact: true }).fill(code);
  await page
    .getByRole("button", { name: "Verify and continue action", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Verify this management action",
      exact: true,
    })
    .waitFor({ state: "detached" });
}
