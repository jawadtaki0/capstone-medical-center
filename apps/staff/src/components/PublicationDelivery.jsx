const labels = {
  pending: "Pending delivery",
  sending: "Sending — awaiting acknowledgement",
  failed: "Delivery failed — retained for retry",
  accepted: "Receiver accepted",
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
        Local Publish saves an immutable version and delivery work. Receiver
        acceptance is separate; public visibility follows each Beirut effective
        date. This isolated review does not change the normal Atlas website
        source.
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
                  <h3>Publication {job.sequence}</h3>
                  <p role="status">
                    {labels[job.state] ?? "Status unavailable"}
                  </p>
                  <p className="staff-help">
                    Effective from {job.effectiveFrom} · Delivery attempts:{" "}
                    {job.attempts}
                  </p>
                  {job.state === "accepted" && (
                    <p>
                      Included in receiver-accepted version{" "}
                      {job.acceptedSequence}. Changes become visible according
                      to their effective dates, not merely when delivery is
                      accepted.
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
