export default function PrototypeDialog({ dialogRef, action }) {
  // Native dialog provides focus trapping, Escape dismissal, and focus restoration.
  return (
    <dialog
      ref={dialogRef}
      className="prototype-dialog"
      aria-labelledby="preview-title"
      aria-describedby="preview-description"
    >
      <h2 id="preview-title">{action}</h2>
      <p id="preview-description">
        {action === "Patient login"
          ? "Patient sign-in is not available yet."
          : "This action is not available yet. No booking, sign-in or request has been created."}
      </p>
      <form method="dialog">
        <button className="button button-primary" autoFocus>
          Close
        </button>
      </form>
    </dialog>
  );
}
