// Layout only. Structured child panels own their solid reading surfaces.
export default function PublicPage({ children, className = "" }) {
  return (
    <div className={`public-page ${className}`}>
      <div className="public-page__content">{children}</div>
    </div>
  );
}
