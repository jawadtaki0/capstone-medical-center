// Background metadata reads never report activity or extend session deadlines.
// An invalidated generation cannot restore counts after unmount/access loss.
export function startSummaryRefresh({
  read,
  current,
  onValue,
  onError,
  schedule = setInterval,
  unschedule = clearInterval,
}) {
  let alive = true,
    pending = false,
    generation = 0;
  async function refresh() {
    if (!alive || pending || !current()) return;
    pending = true;
    const version = generation;
    try {
      const result = await read();
      if (alive && version === generation && current()) onValue(result);
    } catch (error) {
      if (alive && version === generation && current()) onError(error);
    } finally {
      pending = false;
    }
  }
  const interval = schedule(refresh, 10000);
  refresh();
  return {
    refresh,
    stop() {
      alive = false;
      generation++;
      unschedule(interval);
    },
  };
}

export function todayCards(summary) {
  const c = summary?.capabilities ?? {},
    n = summary?.counts ?? {};
  const cards = [];
  const add = (id, label, target, count, problem = false) =>
    cards.push({ id, label, target, count, problem });
  if (c.book) add("new-booking", "New booking", { view: "bookings" });
  if (c.patients)
    add("patients", c.book ? "Find / register patient" : "Patient search", {
      view: "patients",
    });
  if (c.requests) {
    add(
      "requests",
      "Requests awaiting decision",
      { view: "requests" },
      n.requestsAwaitingDecision,
    );
    add(
      "messages",
      "Messages to send",
      { view: "requests", tab: "messages" },
      n.messagesToSend,
    );
    if (n.trackingDeliveryProblems > 0)
      add(
        "tracking",
        "Tracking delivery problems",
        { view: "requests" },
        n.trackingDeliveryProblems,
        true,
      );
  }
  if (c.bookingView)
    add("bookings", "Today’s bookings", { view: "bookings" }, n.todayBookings);
  if (c.professionals)
    add("professionals", "Professionals", { view: "professionals" });
  if (c.professionals && c.schedules)
    add("affected", "Review affected bookings", {
      view: "schedule",
      affectedBookings: true,
    });
  if (c.schedules) {
    add("weekly", c.professionals ? "Weekly schedule" : "Service hours", {
      view: "schedule",
      scheduleMode: "weekly",
    });
    add("dated", "Changes for a date", {
      view: "schedule",
      scheduleMode: "dated",
    });
    add(
      "unpublished",
      "Unpublished changes",
      { view: "website-updates" },
      n.unpublishedChanges,
    );
    if (n.publicationDeliveryProblems > 0)
      add(
        "publication",
        "Website delivery problems",
        { view: "website-updates" },
        n.publicationDeliveryProblems,
        true,
      );
  }
  if (c.serviceHours && !c.schedules)
    add("services", "Service hours", {
      view: "schedule",
      scheduleMode: "weekly",
    });
  if (c.directory) add("directory", "Staff Directory", { view: "directory" });
  if (c.centerSettings)
    add("settings", "Center settings", { view: "registry" });
  return cards;
}
