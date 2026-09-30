import { useEffect, useState } from "react";

// Used by both pages. Home omits the date so the API determines today in Beirut.
export default function useSchedule(date) {
  const [retryCount, setRetryCount] = useState(0);
  const [result, setResult] = useState({ requestedDate: date, status: "loading", schedule: null });

  useEffect(() => {
    const controller = new AbortController();
    setResult({ requestedDate: date, status: "loading", schedule: null });
    const url = date ? `/api/schedule?date=${encodeURIComponent(date)}` : "/api/schedule";
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Schedule request failed");
        const schedule = await response.json();
        if (schedule.timeZone !== "Asia/Beirut" || typeof schedule.date !== "string"
          || !["published", "unpublished"].includes(schedule.publicationStatus)
          || !Array.isArray(schedule.doctorSessions) || !Array.isArray(schedule.specialistSessions)
          || !Array.isArray(schedule.otherServices) || (date && schedule.date !== date)) {
          throw new Error("Unexpected schedule response");
        }
        return schedule;
      })
      .then((schedule) => {
        if (!controller.signal.aborted) setResult({ requestedDate: date, status: "success", schedule });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ requestedDate: date, status: "error", schedule: null });
      });
    return () => controller.abort();
  }, [date, retryCount]);

  return {
    result: result.requestedDate === date ? result : { status: "loading", schedule: null },
    retry: () => setRetryCount((count) => count + 1),
  };
}
