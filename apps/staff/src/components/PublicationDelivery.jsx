const labels = {
  pending: "Updating — awaiting delivery",
  sending: "Updating — awaiting acknowledgement",
  failed: "Delivery delayed — retained for retry",
  accepted: "Website update accepted",
};
const failures = {
  receiver_unavailable:
    "Receiver unavailable. The local publication is saved; automatic retry will continue.",
  receiver_authentication_failed:
    "Receiver authentication failed. Ask the operator to check the private delivery configuration.",
  receiver_conflict:
    "Receiver refused an ordering or identity conflict. Ask the operator to review it; public data was not replaced by this attempt.",
  receiver_rejected:
    "Receiver rejected this delivery. The local publication remains saved.",
  invalid_acknowledgement:
    "Receiver acceptance was not confirmed. A safe retry is required.",
};

export default function PublicationDelivery({
  configured,
  deliveries = [],
  busy,
  refreshing,
  onRetry,
  onRefresh,
}) {
  return (
    <section
      className="staff-workspace-card publication-delivery"
      aria-labelledby="publication-delivery-title"
    >
      <h2 id="publication-delivery-title">Website delivery</h2>
      <p className="staff-help">
        Failed delivery keeps the last accepted information. Public visibility
        follows the effective date and the website’s configured source.
      </p>
      {!configured && (
        <p role="status">
          Website delivery is not configured in this service. Local publications
          stay saved and pending; no delivery success is implied.
        </p>
      )}
      {configured && (
        <button
          className="staff-button"
          type="button"
          disabled={busy || refreshing}
          aria-busy={refreshing || false}
          onClick={onRefresh}
        >
          Refresh delivery status
        </button>
      )}
      {!deliveries.length ? (
        <p>No publication deliveries in your visible scopes.</p>
      ) : (
        <>
          <p className="staff-help">
            Latest {deliveries.length} visible deliveries (up to 20).
          </p>
          <ul className="operational-list">
            {deliveries.map((job) => (
              <li key={job.id}>
                <div>
                  <h3>Website update</h3>
                  <p role="status">
                    {labels[job.state] ?? "Status unavailable"}
                  </p>
                  <details>
                    <summary>Technical details</summary>
                    <p className="staff-help">
                      Publication {job.sequence} · Effective from{" "}
                      {job.effectiveFrom ?? "undated baseline"} · Delivery
                      attempts: {job.attempts}
                    </p>
                    {job.state === "accepted" && (
                      <p>
                        Receiver-accepted version {job.acceptedSequence}.
                        Acceptance does not switch a legacy website source.
                      </p>
                    )}
                  </details>
                  {job.state === "accepted" && (
                    <p>
                      Effective from{" "}
                      {job.effectiveFrom ?? "the undated baseline"}. Changes
                      become visible according to their effective dates, not
                      merely when delivery is accepted.
                    </p>
                  )}
                  {job.state === "failed" && (
                    <p className="staff-help">
                      {failures[job.lastError] ??
                        "Delivery is retained. Refresh status or request an authorized retry."}
                    </p>
                  )}
                </div>
                {configured && job.canRetry && (
                  <button
                    className="staff-button"
                    type="button"
                    disabled={busy || refreshing || job.state === "sending"}
                    onClick={() => onRetry(job.id)}
                    aria-label={`Retry delivery for publication ${job.sequence}`}
                  >
                    Retry delivery
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
