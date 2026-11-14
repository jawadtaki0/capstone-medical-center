import useSchedule from "../hooks/useSchedule.js";
import { patientToday } from "../../../staff/shared/patient-input.js";

export default function ReceptionHoursNotice({
  language,
  verification = false,
}) {
  const { result } = useSchedule();
  const schedule = result.schedule;
  if (
    schedule?.publicationStatus !== "published" ||
    schedule.date !== patientToday()
  )
    return null;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Beirut",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  const hours = schedule.centerHours;
  const closed =
    schedule.centerClosed === true ||
    (schedule.centerClosed === false &&
      hours &&
      /^\d\d:\d\d$/.test(hours.startTime) &&
      /^\d\d:\d\d$/.test(hours.endTime) &&
      hours.startTime < hours.endTime &&
      (time < hours.startTime || time >= hours.endTime));
  if (!closed) return null;
  return (
    <p className="request-alert">
      {verification
        ? language === "ar"
          ? "المركز مغلق الآن. يتحقق الاستقبال من أرقام واتساب خلال ساعات العمل."
          : "The center is closed now. Reception handles WhatsApp verification during opening hours."
        : language === "ar"
          ? "المركز مغلق الآن. سيراجع الاستقبال الطلب خلال ساعات العمل."
          : "The center is closed now. Reception will review the request during opening hours."}
    </p>
  );
}
