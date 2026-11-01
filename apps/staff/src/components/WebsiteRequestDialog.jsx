import { useId } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
export default function WebsiteRequestDialog({ title, onClose, children }) {
  const id = useId();
  return (
    <OperationalDialog titleId={id} onClose={onClose}>
      <div className="request-dialog-heading">
        <h2 id={id}>{title}</h2>
        <button
          className="request-icon-button"
          type="button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </OperationalDialog>
  );
}
