import {
  cedarEmailLayout,
  escapeHtml,
  paragraph,
} from "../../../shared/cedar-email-layout.mjs";

export const patientLinkLifetimeMinutes = 30;
const messages = {
  "lab-report-ready": {
    en: [
      "Your report is ready",
      "Sign in to Cedar",
      "Sign in to Cedar to view your report under Lab results.",
    ],
    ar: [
      "تقريرك جاهز",
      "تسجيل الدخول إلى سيدر",
      "سجّل الدخول إلى سيدر للاطّلاع على تقريرك ضمن نتائج المختبر.",
    ],
  },
  activate: {
    en: [
      "Activate your Cedar account",
      "Activate account",
      "Open the link to choose a username and password and activate your account.",
    ],
    ar: [
      "فعّل حسابك في سيدر",
      "تفعيل الحساب",
      "افتح الرابط لاختيار اسم مستخدم وكلمة مرور وتفعيل حسابك.",
    ],
  },
  reset: {
    en: [
      "Reset your Cedar password",
      "Reset password",
      "Open the link to set a new password for your account.",
    ],
    ar: [
      "أعد تعيين كلمة مرور سيدر",
      "إعادة تعيين كلمة المرور",
      "افتح الرابط لتعيين كلمة مرور جديدة لحسابك.",
    ],
  },
  "verify-email": {
    en: [
      "Verify your new Cedar email",
      "Verify new email",
      "Open the link and confirm your new email address to update it on your account.",
    ],
    ar: [
      "تحقق من بريد سيدر الجديد",
      "التحقق من البريد الجديد",
      "افتح الرابط وأكّد عنوان بريدك الإلكتروني الجديد لتحديثه في حسابك.",
    ],
  },
};

export function patientLinkEmail({ purpose, link, language }) {
  if (!Object.hasOwn(messages, purpose))
    throw Error("Unknown patient email purpose.");
  const url = new URL(link);
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("Invalid patient email link.");
  const lang = language === "ar" ? "ar" : "en";
  const [subject, action, instruction] = messages[purpose][lang];
  const minutes = patientLinkLifetimeMinutes;
  const expiry = purpose === "lab-report-ready" ? "" :
    lang === "ar"
      ? `يمكن استخدام الرابط مرة واحدة، وتنتهي صلاحيته بعد ${minutes.toLocaleString("ar", { numberingSystem: "arab" })} دقيقة.`
      : `This link can be used once and expires after ${minutes} minutes.`;
  const brand = lang === "ar" ? "مركز سيدر الطبي" : "Cedar Medical Center";
  return {
    subject,
    text: [brand, subject, instruction, `${action}: ${url.href}`, expiry].filter(Boolean).join(
      "\n\n",
    ),
    html: cedarEmailLayout({
      heading: subject,
      preview: instruction,
      language: lang,
      brand,
      body: `${paragraph(instruction)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; margin-bottom: 20px;">
          <tr><td align="center" style="padding: 18px 8px; background-color: #eaf4fb; border: 1px solid #d2e2ed; border-radius: 10px;">
            <a href="${escapeHtml(url.href)}" style="display: inline-block; padding: 11px 20px; border: 1px solid #226b9d; border-radius: 6px; background-color: #226b9d; color: #ffffff; font-weight: 700; text-decoration: none;">${escapeHtml(action)}</a>
          </td></tr>
        </table>
        ${expiry ? paragraph(expiry, "margin-bottom: 0; color: #526979; font-size: 14px;") : ""}`,
    }),
  };
}
