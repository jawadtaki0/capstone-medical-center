// Both asynchronous boundaries must still belong to the current, unexpired
// authorization. In particular, a late QR result must not republish a secret.
export async function loadPrivateEnrollment({
  load,
  renderQr,
  isCurrent,
  onSeed,
  onQr,
  onQrUnavailable,
}) {
  if (!isCurrent()) return;
  const details = await load();
  if (!isCurrent() || !details) return;
  onSeed(details.secret);
  try {
    const image = await renderQr(details.otpauthUri);
    if (isCurrent()) onQr(image);
  } catch {
    // A rendering failure permits manual enrollment only while authorized.
    if (isCurrent()) onQrUnavailable();
  }
}
