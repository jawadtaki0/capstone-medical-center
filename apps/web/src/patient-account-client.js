export async function accountRequest(action, body) {
  const response = await fetch(`/api/patient-account/${action}`, {
    cache: "no-store",
    ...(body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
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
