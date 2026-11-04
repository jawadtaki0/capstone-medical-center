export function isHomepageDemo(development, pathname, search) {
  return (
    development &&
    ["", "/"].includes(pathname) &&
    new URLSearchParams(search).get("preview") !== "live"
  );
}

// A synthetic selection is never allowed into the existing live request route,
// even if a caller accidentally passes it while inspecting live mode.
export function isHomepageDemoSession(session) {
  return [session?.id, session?.professionalId].some(
    (id) => typeof id === "string" && id.startsWith("demo-home-"),
  );
}
