const unavailable = {
  en: "The review server may be waking or temporarily unavailable. Please try again shortly.",
  ar: "قد يكون خادم العرض قيد التشغيل أو غير متاح مؤقتًا. يرجى المحاولة مجددًا بعد قليل.",
};
const uncertainSubmission = {
  en: "Your request may already have been received. Keep this page open and retry without changing the details to recover the same receipt. No place is reserved until staff confirms.",
  ar: "ربما تم استلام طلبك بالفعل. أبقِ هذه الصفحة مفتوحة وأعد المحاولة دون تغيير البيانات لاسترجاع إيصال الطلب نفسه. لا يُحجز مكان حتى يؤكد الموظف.",
};

function unavailableError(submission) {
  const forLanguage = (language) => {
    const lang = language === "ar" ? "ar" : "en";
    return (
      unavailable[lang] + (submission ? ` ${uncertainSubmission[lang]}` : "")
    );
  };
  return Object.assign(Error(forLanguage("en")), {
    code: "request_unavailable",
    forLanguage,
  });
}

// Local development stays same-origin. Hosted review uses one public build-time
// Render origin, avoiding an extra proxy/cold-start timeout. No request/user input
// can choose a destination and no integration credential belongs in this bundle.
export function createRequestClient({
  request = fetch,
  timeoutMs = 75000,
  apiOrigin = "",
} = {}) {
  if (apiOrigin !== "") {
    let url;
    try {
      url = new URL(apiOrigin);
    } catch {
      throw Error("Invalid review API origin.");
    }
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/.test(
        url.hostname,
      ) ||
      url.origin !== apiOrigin ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("Invalid review API origin.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Error("Invalid request timeout.");
  return async (action, body, signal) => {
    if (
      !/^(?:submit|track|(?:sessions|professionals)\?date=\d{4}-\d{2}-\d{2})$/.test(
        action,
      )
    )
      throw Error("Invalid request action.");
    const deadline = AbortSignal.timeout(timeoutMs),
      combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await request(`${apiOrigin}/api/requests/${action}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        credentials: "omit",
        signal: combined,
      });
      const data = await response.json().catch(() => null);
      if (response.status >= 500 || !data || typeof data !== "object")
        throw unavailableError(action === "submit");
      if (!response.ok) {
        const message = data.error?.message;
        if (typeof message !== "string" || !message || message.length > 600)
          throw unavailableError(action === "submit");
        throw Object.assign(Error(message), { code: data.error?.code });
      }
      const valid =
        action.startsWith("sessions?") || action.startsWith("professionals?")
          ? Array.isArray(data)
          : action === "submit"
            ? typeof data.reference === "string" &&
              /^[A-Za-z0-9_-]{43}$/.test(data.trackingToken)
            : typeof data.reference === "string" &&
              ["awaiting", "confirmed", "rejected", "cancelled"].includes(
                data.status,
              ) &&
              Array.isArray(data.events);
      if (!valid) throw unavailableError(action === "submit");
      return data;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (typeof error.code === "string" && error.code.startsWith("request_"))
        throw error;
      throw unavailableError(action === "submit");
    }
  };
}

// A failed/uncertain send and navigating back without meaningful edits must use
// the original key. Only the exact submitted patient/selection changes it.
export function createSubmissionAttempt(makeKey) {
  let signature, key;
  return (patient, session, honeypot = "") => {
    const next = JSON.stringify({
      patient: Object.fromEntries(
        [
          "firstName",
          "fatherName",
          "lastName",
          "motherFirstName",
          "dateOfBirth",
          "phone",
          "gender",
          "preferredLanguage",
        ].map((field) => [field, patient[field]]),
      ),
      selection: {
        date: session?.date,
        professionalId: session?.professionalId,
        sourceSessionId: session?.sourceSessionId ?? session?.id,
      },
      honeypot,
    });
    if (next !== signature) {
      signature = next;
      key = makeKey();
    }
    return key;
  };
}
