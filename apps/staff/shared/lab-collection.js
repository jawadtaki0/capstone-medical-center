export function hasLabCollection(order) {
  return (
    order.status === "Sample collected" ||
    order.specimens.some((row) => row.checked) ||
    order.history.some(
      (event) =>
        event.action === "collect" ||
        (event.action === "check" && event.checked === true),
    )
  );
}
