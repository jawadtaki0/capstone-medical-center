export async function accountRequest(action, body, signal) {
  const response = await fetch(`/api/patient-account/${action}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
    ...(body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (action === "lab-report" && response.ok) {
    if (response.headers.get("content-type") !== "application/pdf")
      throw Object.assign(new Error("Download unavailable"), {
        code: "report_unavailable",
      });
    return response.blob();
  }
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.message ?? data.error), {
      code: data.error,
    });
  return data;
}

export async function signOutAndContinueAsGuest() {
  await accountRequest("signout", {});
  window.location.assign("/request");
}
