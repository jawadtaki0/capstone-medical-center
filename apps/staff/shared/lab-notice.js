const signIn = "https://cmc-cedar.site/account";

export function labNotice(order) {
  const entry = order.history.findLastIndex(
    (item) =>
      ["recollect", "release-report", "withdraw-report"].includes(
        item.action,
      ) ||
      (["cancel", "cancel-test"].includes(item.action) &&
        item.status === "Cancelled"),
  );
  if (entry < 0) return null;
  const event = order.history[entry];
  const version = order.reportVersions?.at(-1);
  if (
    event.action === "release-report" &&
    (order.status !== "Released" ||
      version?.id !== event.target ||
      version.status !== "Released")
  )
    return null;
  const kind =
    event.action === "recollect"
      ? "recollection"
      : event.action === "withdraw-report"
        ? "withdrawal"
        : event.action === "release-report"
          ? version.corrected
            ? "corrected"
            : "release"
          : "cancellation";
  return {
    id: String(entry),
    kind,
    ...(event.action === "release-report" ? { report: version } : {}),
  };
}

export function labMessage(kind, language, name, order) {
  const ar = language === "ar";
  const link = ar ? signIn + "?lang=ar" : signIn;
  switch (kind) {
    case "recollection":
      return ar
        ? `مرحبًا من مركز سيدر الطبي. نحتاج إلى عينة جديدة للمريض ${name}، رقم طلب المختبر ${order}. يُرجى التواصل معنا قبل الحضور لمعرفة كيفية التحضير.`
        : `Hello from Cedar Medical Center. We need another sample for ${name}, lab order ${order}. Please contact us before returning so we can explain how to prepare.`;
    case "cancellation":
      return ar
        ? `مرحبًا من مركز سيدر الطبي. تم إلغاء طلب المختبر رقم ${order} للمريض ${name}. يُرجى التواصل معنا للاستفسار أو لتقديم طلب جديد.`
        : `Hello from Cedar Medical Center. Lab order ${order} for ${name} has been cancelled. Please contact us if you have questions or need to arrange a new order.`;
    case "release":
      return ar
        ? `مرحبًا من مركز سيدر الطبي. تقرير المختبر للمريض ${name}، رقم الطلب ${order}، جاهز ومرفق بهذه الرسالة. يمكنكم أيضًا تسجيل الدخول إلى موقع سيدر لتنزيله: ${link}`
        : `Hello from Cedar Medical Center. The lab report for ${name}, order ${order}, is ready and attached. You can also sign in to Cedar to download it: ${link}`;
    case "withdrawal":
      return ar
        ? `مرحبًا من مركز سيدر الطبي. تم سحب تقرير المختبر السابق للمريض ${name}، رقم الطلب ${order}. يُرجى التوقف عن استخدام النسخة السابقة. سنتواصل معكم عند توفر التقرير المصحّح.`
        : `Hello from Cedar Medical Center. We’ve withdrawn the earlier lab report for ${name}, order ${order}. Please stop using that copy. We’ll contact you when a corrected report is available.`;
    case "corrected":
      return ar
        ? `مرحبًا من مركز سيدر الطبي. تقرير المختبر المصحّح للمريض ${name}، رقم الطلب ${order}، مرفق بهذه الرسالة. يُرجى استخدام هذه النسخة بدلًا من النسخة السابقة. يمكنكم أيضًا تسجيل الدخول إلى موقع سيدر لتنزيلها: ${link}`
        : `Hello from Cedar Medical Center. The corrected lab report for ${name}, order ${order}, is attached. Please use this version in place of the earlier copy. You can also sign in to Cedar to download it: ${link}`;
  }
  throw Error("Unknown Lab notice.");
}
