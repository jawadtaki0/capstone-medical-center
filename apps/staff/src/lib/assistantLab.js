import { hasLabCollection } from "../../shared/lab-collection.js";

// Which orders a Lab card offers. The server checks every action again.
export function eligibleOrders(orders, task, roles) {
  const lab = roles.includes("Admin") || roles.includes("Lab Admin"),
    reception = roles.includes("Receptionist");
  return orders.filter((order) => {
    if (task === "collect")
      return (lab || reception) && order.status === "Registered";
    if (task === "release") return releasableReport(order) !== null;
    const report = order.reportVersions?.at(-1)?.status;
    if (task === "recollect") return lab && order.status === "Sample collected";
    if (task === "reopen")
      return (
        lab && order.status === "Ready to release" && report === "Finalized"
      );
    if (task === "withdraw")
      return order.status === "Released" && report === "Released";
    return (
      (lab && ["Registered", "Sample collected"].includes(order.status)) ||
      (reception && order.status === "Registered" && !hasLabCollection(order))
    );
  });
}

export function releasableReport(order) {
  const current = order.reportVersions?.at(-1);
  return order.status === "Ready to release" && current?.status === "Finalized"
    ? current
    : null;
}

// The numbers are what staff typed from the PDF; the server compares them.
export function releaseRequest(order, { patientNumber, orderNumber }) {
  return {
    action: "release-report",
    id: order._id,
    revision: order.revision,
    reportId: releasableReport(order)?.id,
    patientNumber: patientNumber.trim(),
    orderNumber: orderNumber.trim(),
  };
}

export function requiredSpecimens(order) {
  return order.specimens.filter((row) =>
    row.testIds.some((id) =>
      order.tests.some((test) => test._id === id && !test.cancelled),
    ),
  );
}

// One confirmation: tick what is still unticked, then mark the order collected.
// Each step carries the latest revision, so a changed order stops it.
export async function collectOrder(api, order) {
  let latest = order;
  const send = async (action, extra = {}) =>
    (latest = await api.lab({
      action,
      id: order._id,
      revision: latest.revision,
      ...extra,
    }));
  for (const row of requiredSpecimens(order))
    if (!row.checked) await send("check", { target: row.id, checked: true });
  return send("collect");
}
