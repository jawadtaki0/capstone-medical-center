export default function PhoneVerificationNotice({ language = "en" }) {
  const arabic = language === "ar";
  return (
    <div
      className="phone-verification-notice"
      lang={language}
      dir={arabic ? "rtl" : "ltr"}
    >
      <span>
        {arabic
          ? "تحقّق من رقم واتساب للحجز عبر حسابك."
          : "Verify your WhatsApp number to book."}
      </span>
      <a
        className="button button-primary"
        href={`/account?view=verify-phone${arabic ? "&lang=ar" : ""}`}
      >
        {arabic ? "تحقق من رقم الهاتف" : "Verify phone"}
      </a>
    </div>
  );
}
