// A restrained adaptation of React Bits' rim highlight. CSS paints the
// highlight only during interaction, so there is no idle rendering loop.
export default function SpecularButton({ children, onClick, className = "" }) {
  return (
    <button
      className={`button button-primary specular-button ${className}`}
      type="button"
      onClick={onClick}
    >
      <span className="specular-shine" aria-hidden="true" />
      <span className="specular-label">{children}</span>
    </button>
  );
}
