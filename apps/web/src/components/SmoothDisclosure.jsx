import { useId, useState } from "react";
import Icon from "./Icon.jsx";
import "./smoothDisclosure.css";

// Intrinsic grid tracks animate both directions without measuring or scaling text.
// Inert keeps collapsed links out of keyboard navigation, including during close.
export default function SmoothDisclosure({ title, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="smooth-disclosure" data-open={open}>
      <button
        type="button"
        className="smooth-disclosure-trigger"
        id={`${id}-trigger`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <Icon name="chevron" />
      </button>
      <div
        className="smooth-disclosure-panel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-trigger`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="smooth-disclosure-clip">
          <div className="smooth-disclosure-answer">{children}</div>
        </div>
      </div>
    </div>
  );
}
