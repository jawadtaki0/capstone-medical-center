// The read-only public API derives this presentation variant from profile data.
// There is no duplicated profile-ID assignment list or client-side guessing.
export const avatarSheet = new URL(
  "../assets/avatars/professional-silhouettes.png",
  import.meta.url,
).href;

export function normalizeAvatarVariant(value) {
  return value === "male" || value === "female" ? value : "neutral";
}

export function avatarState(value, failed = false) {
  const variant = normalizeAvatarVariant(value);
  return {
    variant,
    state:
      variant === "neutral" ? "neutral" : failed ? "unavailable" : "supplied",
  };
}
