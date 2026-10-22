import { useEffect, useRef } from "react";

export default function OperationalDialog({
  titleId,
  busy,
  onClose,
  children,
}) {
  const ref = useRef(null),
    current = useRef({ busy, onClose });
  current.current = { busy, onClose };
  useEffect(() => {
    const opener = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current.querySelector("input,select,button")?.focus();
    function keyDown(event) {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      if (dialogs.at(-1) !== ref.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!current.current.busy) current.current.onClose();
      }
      if (event.key === "Tab") {
        const controls = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          ref.current.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            !ref.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !ref.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.body.style.overflow = overflow;
      if (opener?.isConnected && !opener.disabled) opener.focus();
    };
  }, []);
  useEffect(() => {
    // Closing the nested manager-verification dialog may restore focus to the
    // page while this editor was disabled. Reclaim it only once this topmost
    // editor is interactive again; never steal focus from another dialog.
    if (
      !busy &&
      ref.current &&
      [...document.querySelectorAll('[role="dialog"]')].at(-1) ===
        ref.current &&
      !ref.current.contains(document.activeElement)
    ) {
      (
        ref.current.querySelector(
          "input:not(:disabled),select:not(:disabled),button:not(:disabled)",
        ) ?? ref.current
      ).focus();
    }
  }, [busy]);
  return (
    <div className="staff-modal-backdrop">
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="staff-verification-dialog operational-dialog"
      >
        {children}
      </section>
    </div>
  );
}
