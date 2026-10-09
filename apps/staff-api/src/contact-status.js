export function contactStatus(profile, vault) {
  const proof = profile?.emailVerification;
  const matches =
    proof &&
    proof.verifiedAt instanceof Date &&
    Number.isFinite(proof.verifiedAt.getTime()) &&
    proof.method === "email_code" &&
    proof.provider === "gmail" &&
    proof.valueDigest === vault.contactDigest(String(profile.email));
  return {
    email:
      matches && Object.hasOwn(proof, "releasedAt")
        ? "released"
        : matches && proof.mode === "live" && proof.provider === "gmail"
          ? "verified"
          : matches && proof.mode === "test"
            ? "test_only"
            : "unverified",
    phone: "unverified",
  };
}

export function reservesEmail(profile, vault, includeTest = false) {
  const status = contactStatus(profile, vault).email;
  return status === "verified" || (includeTest && status === "test_only");
}
