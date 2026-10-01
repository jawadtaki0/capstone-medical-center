import { useState } from "react";
import { avatarSheet, avatarState } from "../data/professionalAvatars.js";

export default function ProfessionalAvatar({ avatarVariant, source = avatarSheet }) {
  const [failedSource, setFailedSource] = useState(null);
  const failed = failedSource === source || typeof source !== "string" || !source.trim();
  const { variant, state } = avatarState(avatarVariant, failed);
  return <span className="professional-avatar" aria-hidden="true" data-avatar-state={state} data-avatar-variant={variant}>
    {state === "supplied" ? <span className="professional-avatar__crop">
      <img className="professional-avatar__sheet" src={source} alt="" width="398" height="309" loading="lazy" onError={() => setFailedSource(source)} />
    </span> : <svg viewBox="0 0 24 24" fill="currentColor" focusable="false">
      <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />
    </svg>}
  </span>;
}
