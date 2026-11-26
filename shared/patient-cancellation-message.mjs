export function patientCancellationMessage(
  { professional, date, startTime, endTime, contact },
  language,
) {
  const time = startTime + "–" + endTime;
  const en = {
    subject: "Your Cedar appointment was cancelled",
    text:
      "Cedar: Your Clinic appointment with " +
      professional +
      " on " +
      date +
      " at " +
      time +
      " Beirut time was cancelled at your request. To book again or get help, contact Cedar Reception at " +
      contact +
      ".",
  };
  const ar = {
    subject: "أُلغي موعدك في سيدر",
    text:
      "سيدر: أُلغي موعدك لخدمة العيادة مع " +
      professional +
      " بتاريخ " +
      date +
      " الساعة " +
      time +
      " بتوقيت بيروت بناءً على طلبك. لحجز موعد جديد أو طلب المساعدة، تواصل مع استقبال سيدر على " +
      contact +
      ".",
  };
  return language === "en"
    ? en
    : language === "ar"
      ? ar
      : {
          subject: en.subject + " / " + ar.subject,
          text: en.text + "\n\n" + ar.text,
        };
}
