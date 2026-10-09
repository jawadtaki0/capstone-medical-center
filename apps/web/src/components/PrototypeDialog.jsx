export default function PrototypeDialog({ dialogRef, action }) {
  // Native dialog provides focus trapping, Escape dismissal, and focus restoration.
  return (
    <dialog
      ref={dialogRef}
      className="prototype-dialog"
      aria-labelledby="preview-title"
      aria-describedby="preview-description"
    >
      <p className="eyebrow">PUBLIC SITE PROTOTYPE</p>
      <h2 id="preview-title">{action}</h2>
      <p id="preview-description">
        This action is a visual placeholder. No booking, sign-in, or request has
        been created.
      </p>
      <form method="dialog">
        <button className="button button-primary" autoFocus>
          Close
        </button>
      </form>
    </dialog>
  );
}
