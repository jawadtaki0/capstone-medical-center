import { lazy, Suspense, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import PublicPage from "../components/PublicPage.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import {
  accountRequest,
  signOutAndContinueAsGuest,
} from "../patient-account-client.js";
import { AccountProfiles, AddProfiles } from "./AccountProfiles.jsx";
import ReceptionHoursNotice from "../components/ReceptionHoursNotice.jsx";
import PhoneVerificationNotice from "../components/PhoneVerificationNotice.jsx";
import PatientPhoneVerification from "./PatientPhoneVerification.jsx";
import PatientDetailsFields from "../request-preview/PatientDetailsFields.jsx";
import { RequestPhone } from "../request-preview/FormControls.jsx";
import {
  PATIENT_FIELDS,
  childBirthDateAllowed,
  patientInput,
  patientToday,
} from "../../../staff/shared/patient-input.js";
import "../request-preview/preview.css";

const SignInPage = lazy(() =>
  import("@toolpad/core/SignInPage").then((module) => ({
    default: module.SignInPage,
  })),
);
const credentials = [{ id: "credentials", name: "Cedar" }];

const copy = {
  signin: ["Sign in", "تسجيل الدخول"],
  signup: ["Create account", "إنشاء حساب"],
  recover: ["Forgot password?", "هل نسيت كلمة المرور؟"],
  phone: ["Phone number", "رقم الهاتف"],
  "recover-phone": ["Recover by WhatsApp", "استعادة الحساب عبر واتساب"],
  "phone-reset": [
    "Reset password by WhatsApp",
    "إعادة تعيين كلمة المرور عبر واتساب",
  ],
  recoveryPhoneSent: [
    "If the number is eligible, reception will prepare a WhatsApp code.",
    "إذا كان الرقم مؤهلاً، فسيجهز الاستقبال رمز واتساب.",
  ],
  activate: ["Activate account", "تفعيل الحساب"],
  reset: ["Set a new password", "تعيين كلمة مرور جديدة"],
  "verify-email": ["Verify new email", "التحقق من البريد الإلكتروني الجديد"],
  "replace-email": ["Change email", "تغيير البريد الإلكتروني"],
  delete: ["Delete account", "حذف الحساب"],
  signout: ["Sign out", "تسجيل الخروج"],
  account: ["My account", "حسابي"],
  language: ["Page language", "لغة الصفحة"],
  loginId: [
    "Email, username, or verified phone",
    "البريد الإلكتروني أو اسم المستخدم أو رقم الهاتف المتحقق منه",
  ],
  patientDetails: ["Patient details", "بيانات المريض"],
  accountContact: ["Account contact", "بيانات التواصل للحساب"],
  relationship: ["Who is the patient?", "من هو المريض؟"],
  self: ["Myself", "أنا"],
  child: ["My child", "طفلي"],
  both: ["Both", "كلاهما"],
  addProfiles: ["Add profile", "إضافة ملف"],
  saveProfiles: ["Save profiles", "حفظ الملفات"],
  self_profile_exists: [
    "Your own profile already exists.",
    "ملفك الشخصي موجود بالفعل.",
  ],
  requestSession: ["Request a session", "طلب جلسة"],
  viewRequests: ["View requests", "عرض الطلبات"],
  noRequests: ["No requests yet.", "لا توجد طلبات بعد."],
  awaiting: ["Awaiting confirmation", "بانتظار التأكيد"],
  confirmed: ["Confirmed", "مؤكد"],
  rejected: ["Declined", "مرفوض"],
  cancelled: ["Cancelled", "ملغى"],
  verifyPhone: ["Verify phone", "تحقق من رقم الهاتف"],
  phone_verification_required: [
    "Verify your WhatsApp number to request a booking while signed in.",
    "تحقق من رقم واتساب لطلب حجز أثناء تسجيل الدخول.",
  ],
  personalPhone: [
    "This is my personal number. Use it to sign in if it is available.",
    "هذا رقمي الشخصي. استخدمه لتسجيل الدخول إذا كان متاحًا.",
  ],
  requestCode: ["Request WhatsApp code", "اطلب رمز واتساب"],
  requestNewCode: ["Request a new code", "اطلب رمزًا جديدًا"],
  phoneCodeWaiting: [
    "Reception prepares your WhatsApp message. Enter the six-digit code when it arrives.",
    "يجهز الاستقبال رسالة واتساب. أدخل الرمز المكوّن من ستة أرقام عند وصوله.",
  ],
  phoneCode: ["WhatsApp code", "رمز واتساب"],
  checkCode: ["Verify code", "تحقق من الرمز"],
  phoneVerified: [
    "WhatsApp number verified. You can request a booking.",
    "تم التحقق من رقم واتساب. يمكنك طلب حجز.",
  ],
  invalid_phone_code: [
    "Enter the correct six-digit code.",
    "أدخل الرمز الصحيح المكوّن من ستة أرقام.",
  ],
  phone_code_unavailable: [
    "The code is unavailable or expired. Check your message or request a new code when available.",
    "الرمز غير متاح أو منتهي الصلاحية. تحقق من الرسالة أو اطلب رمزًا جديدًا عند توفره.",
  ],
  guest: ["Sign out and continue as guest", "تسجيل الخروج والمتابعة كضيف"],
  accountContactHelp: [
    "This number will be used as the child’s booking contact. It still needs verification for your account.",
    "سيُستخدم هذا الرقم للتواصل بشأن حجوزات الطفل. لا يزال الرقم بحاجة إلى التحقق لحسابك.",
  ],
  childAgeHint: ["For patients under 18", "للمرضى دون ١٨ عامًا"],
  invalid_child_birth_date: [
    "The patient must be under 18.",
    "يجب أن يكون عمر المريض أقل من ١٨ عامًا.",
  ],
  continue: ["Continue", "متابعة"],
  invalid_account_phone: [
    "Enter a valid account phone number.",
    "أدخل رقم هاتف صحيحًا للحساب.",
  ],
  invalid_patient: [
    "Check the highlighted patient details.",
    "راجع بيانات المريض المحددة.",
  ],
  invalid_relationship: ["Choose who the patient is.", "حدد من هو المريض."],
  email: ["Email address", "البريد الإلكتروني"],
  newEmail: ["New email address", "البريد الإلكتروني الجديد"],
  password: ["Password", "كلمة المرور"],
  currentPassword: ["Re-enter your password", "أعد إدخال كلمة المرور"],
  newPassword: [
    "New password (at least 12 characters)",
    "كلمة مرور جديدة (١٢ حرفًا على الأقل)",
  ],
  send: ["Send email link", "إرسال الرابط بالبريد الإلكتروني"],
  busy: ["Please wait…", "يرجى الانتظار…"],
  cancel: ["Cancel", "إلغاء"],
  back: ["Back to sign in", "العودة إلى تسجيل الدخول"],
  verified: ["Verified email", "البريد الإلكتروني المتحقق منه"],
  username: ["Username", "اسم المستخدم"],
  usernameChoices: [
    "Choose a suggestion or enter your own username.",
    "اختر اقتراحًا أو أدخل اسم مستخدم من اختيارك.",
  ],
  usernameRefresh: ["New suggestions", "اقتراحات جديدة"],
  invalid_username: [
    "Use 3–32 letters, numbers, dots, underscores or hyphens, starting with a letter.",
    "استخدم من ٣ إلى ٣٢ حرفًا أو رقمًا أو نقطة أو شرطة، وابدأ بحرف.",
  ],
  username_taken: [
    "That username is taken. Try another name or get new suggestions.",
    "اسم المستخدم مستخدم بالفعل. جرّب اسمًا آخر أو اطلب اقتراحات جديدة.",
  ],
  signupInfo: [
    "Verify your email to activate your account and set a password.",
    "تحقق من بريدك الإلكتروني لتفعيل حسابك وتعيين كلمة مرور.",
  ],
  recoverInfo: [
    "Enter your verified email to request a password reset link.",
    "أدخل بريدك الإلكتروني المتحقق منه لطلب رابط إعادة تعيين كلمة المرور.",
  ],
  deleteInfo: [
    "Deleting your online account ends online access and signs you out on all devices. Your bookings and clinic records are kept.",
    "يؤدي حذف حسابك الإلكتروني إلى إنهاء الوصول وتسجيل الخروج على جميع الأجهزة. تبقى حجوزاتك وسجلاتك الطبية محفوظة.",
  ],
  replaceInfo: [
    "Your current email stays active until you verify the new address.",
    "يبقى بريدك الإلكتروني الحالي فعالًا إلى أن تتحقق من العنوان الجديد.",
  ],
  mailSent: [
    "If this address is eligible, Cedar will send an email link.",
    "إذا كان هذا العنوان مؤهلًا، سيرسل سيدر رابطًا بالبريد الإلكتروني.",
  ],
  replacementSent: [
    "Check your new email for the verification link.",
    "تحقق من بريدك الإلكتروني الجديد للحصول على رابط التحقق.",
  ],
  activated: [
    "Your email is verified. You can sign in.",
    "تم التحقق من بريدك الإلكتروني. يمكنك تسجيل الدخول.",
  ],
  resetDone: [
    "Password updated. Sign in with your new password.",
    "تم تحديث كلمة المرور. سجل الدخول بكلمة المرور الجديدة.",
  ],
  emailDone: [
    "Your new email is verified and active.",
    "تم التحقق من بريدك الإلكتروني الجديد وتفعيله.",
  ],
  deleted: ["Your online account was deleted.", "تم حذف حسابك الإلكتروني."],
  invalid_signin: [
    "Check your sign-in details or verify your email first.",
    "تحقق من بيانات تسجيل الدخول أو تحقق من بريدك الإلكتروني أولًا.",
  ],
  invalid_identifier: [
    "Enter a valid email, phone number, or username of 3–32 characters starting with a letter.",
    "أدخل بريدًا إلكترونيًا أو رقم هاتف صالحًا أو اسم مستخدم من ٣ إلى ٣٢ حرفًا يبدأ بحرف.",
  ],
  invalid_email: [
    "Enter a valid email address.",
    "أدخل بريدًا إلكترونيًا صالحًا.",
  ],
  invalid_password: [
    "Check the password length and try again.",
    "تحقق من طول كلمة المرور وحاول مجددًا.",
  ],
  incorrect_password: ["That password is incorrect.", "كلمة المرور غير صحيحة."],
  invalid_link: [
    "This link has expired or has already been used. Request a new link.",
    "انتهت صلاحية الرابط أو تم استخدامه. اطلب رابطًا جديدًا.",
  ],
  identifier_unavailable: [
    "That email or username is unavailable.",
    "البريد الإلكتروني أو اسم المستخدم غير متاح.",
  ],
  same_email: [
    "Enter a different email address.",
    "أدخل بريدًا إلكترونيًا مختلفًا.",
  ],
  sign_in_required: [
    "Sign in again to continue.",
    "سجل الدخول مرة أخرى للمتابعة.",
  ],
  try_later: [
    "Cedar could not complete the request. Try again shortly.",
    "تعذر إكمال الطلب. حاول مجددًا بعد قليل.",
  ],
};

function linkAction(params) {
  const action = params.get("action");
  return ["activate", "reset", "verify-email"].includes(action) ? action : "";
}

const accountTheme = (direction) =>
  createTheme({
    direction,
    palette: { primary: { main: "#226b9d" } },
    typography: { fontFamily: "var(--cedar-public-font)" },
    components: {
      MuiContainer: { defaultProps: { role: "presentation" } },
      MuiButton: {
        defaultProps: { disableFocusRipple: true },
        styleOverrides: {
          root: {
            "&&:focus-visible": {
              outline: "2px solid #41464b",
              outlineOffset: "2px",
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            "&.Mui-focused:not(.Mui-error) .MuiOutlinedInput-notchedOutline": {
              borderColor: "#41464b",
            },
            "&& :is(input, select):focus-visible": { outline: "none" },
          },
          notchedOutline: { textAlign: direction === "rtl" ? "right" : "left" },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: {
            "&:not(.Mui-error, .Mui-disabled)": { color: "var(--blue)" },
            ...(direction === "rtl"
              ? {
                  left: "auto",
                  right: 0,
                  transformOrigin: "top right",
                  transform: "translate(-14px, 16px) scale(1)",
                  "&.MuiInputLabel-shrink": {
                    transform: "translate(-14px, -9px) scale(.75)",
                  },
                }
              : {}),
          },
        },
      },
    },
  });
const themes = { en: accountTheme("ltr"), ar: accountTheme("rtl") };

function Field({ minLength, maxLength, dir, ...props }) {
  return (
    <TextField
      fullWidth
      required
      {...props}
      slotProps={{ htmlInput: { minLength, maxLength, dir } }}
    />
  );
}

const omitHeading = () => null;
const emptyPatient = Object.fromEntries(PATIENT_FIELDS.map((key) => [key, ""]));

function SignInLinks({ language, disabled, show, t }) {
  return (
    <div className="request-actions">
      {["signup", "recover"].map((next) => (
        <Link
          key={next}
          href={`?view=${next}&lang=${language}`}
          variant="body2"
          onClick={(event) => {
            if (
              disabled ||
              !(
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
            ) {
              event.preventDefault();
              if (!disabled) show(next);
            }
          }}
          aria-disabled={disabled || undefined}
        >
          {t(next)}
        </Link>
      ))}
    </div>
  );
}

export default function PatientAccountPage({ account, onAccount }) {
  const [link, setLink] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)),
  );
  const [mode, setMode] = useState(() => {
    const next = new URLSearchParams(window.location.search).get("view");
    return (
      linkAction(link) ||
      (["signup", "recover", "recover-phone", "phone-reset"].includes(next)
        ? next
        : "")
    );
  });
  const [language, setLanguage] = useState(() =>
    new URLSearchParams(window.location.search).get("lang") === "ar"
      ? "ar"
      : "en",
  );
  const [patient, setPatient] = useState(emptyPatient);
  const [patientErrors, setPatientErrors] = useState({});
  const [relationship, setRelationship] = useState("self");
  const child = relationship === "child";
  const [username, setUsername] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionRefresh, setSuggestionRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const t = (key) =>
    copy[key]?.[language === "ar" ? 1 : 0] ??
    copy.try_later[language === "ar" ? 1 : 0];
  const view =
    mode ||
    (account
      ? new URLSearchParams(window.location.search).get("view") ===
          "verify-phone" && !account.bookingPhone
        ? "verifyPhone"
        : "account"
      : "signin");
  const activationToken = view === "activate" ? link.get("token") : null;

  useEffect(() => {
    if (link.has("token"))
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, [link]);

  useEffect(() => {
    function readLink() {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const action = linkAction(params);
      if (!action || !params.has("token")) return;
      setLink(params);
      setMode(action);
      setUsername("");
      setSuggestions([]);
      setNotice("");
      setError("");
    }
    window.addEventListener("hashchange", readLink);
    return () => window.removeEventListener("hashchange", readLink);
  }, []);

  useEffect(() => {
    if (!activationToken) return;
    let active = true;
    accountRequest("username-suggestions", {
      token: activationToken,
      refresh: suggestionRefresh > 0,
    }).then(
      (result) => {
        if (active) setSuggestions(result.suggestions);
      },
      (cause) => {
        if (active) setError(cause.message);
      },
    );
    return () => {
      active = false;
    };
  }, [activationToken, suggestionRefresh]);

  function show(next) {
    setMode(next);
    setPatient(emptyPatient);
    setPatientErrors({});
    setRelationship("self");
    setError("");
    setNotice("");
  }

  function editPatient(key, value) {
    setPatient({ ...patient, [key]: value });
    setPatientErrors({ ...patientErrors, [key]: undefined });
  }

  async function signIn(_provider, fields) {
    setBusy(true);
    setNotice("");
    try {
      const result = await accountRequest("signin", {
        identifier: fields.get("identifier"),
        password: fields.get("password"),
      });
      onAccount(result.account);
    } catch (cause) {
      return { error: t(cause.message) };
    } finally {
      setBusy(false);
    }
  }

  async function submit(event, action = view) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields =
      action === "signout" ? {} : Object.fromEntries(new FormData(form));
    if (action === "signup") {
      const today = patientToday();
      const { errors } = patientInput(patient, today);
      if (
        child &&
        !errors.dateOfBirth &&
        !childBirthDateAllowed(patient.dateOfBirth, today)
      )
        errors.dateOfBirth = "invalid_child_birth_date";
      setPatientErrors(errors);
      if (Object.keys(errors).length) {
        setError("");
        return;
      }
      Object.assign(
        fields,
        child
          ? { patient: { ...patient, phone: undefined }, phone: patient.phone }
          : { patient },
      );
    }
    const token = ["activate", "reset", "verify-email"].includes(action)
      ? link.get("token")
      : undefined;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "guest") {
        await signOutAndContinueAsGuest();
        return;
      }
      await accountRequest(
        action === "recover-phone" ? "phone-recover" : action,
        action === "phone-reset" ? fields : { ...fields, token, language },
      );
      if (action === "recover-phone") {
        setMode("phone-reset");
        setNotice("recoveryPhoneSent");
        return;
      }
      form.reset();
      if (["delete", "signout", "reset", "phone-reset"].includes(action))
        onAccount(null);
      if (action === "verify-email")
        onAccount((await accountRequest("session")).account);
      setMode("");
      setPatient(emptyPatient);
      setRelationship("self");
      setNotice(
        {
          signup: "mailSent",
          recover: "mailSent",
          activate: "activated",
          reset: "resetDone",
          "phone-reset": "resetDone",
          "replace-email": "replacementSent",
          "verify-email": "emailDone",
          delete: "deleted",
        }[action] ?? "",
      );
    } catch (cause) {
      if (action === "signup" && cause.message === "invalid_child_birth_date") {
        setPatientErrors({ dateOfBirth: cause.message });
        return;
      }
      if (cause.message === "sign_in_required") {
        onAccount(null);
        setMode("");
      }
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  const passwordField = [
    "phone-reset",
    "replace-email",
    "delete",
    "activate",
    "reset",
  ].includes(view);
  const newPassword = ["activate", "reset", "phone-reset"].includes(view);
  const submitLabel =
    view === "signup"
      ? "continue"
      : ["recover", "replace-email"].includes(view)
        ? "send"
        : view === "recover-phone"
          ? "requestCode"
          : view;
  return (
    <PublicPage className="public-request-page">
      <ThemeProvider theme={themes[language]}>
        <div
          className="container request-shell patient-account-shell"
          style={{
            maxWidth: view === "signup" ? "50rem" : "40rem",
            marginInline: "auto",
            display: "grid",
            gap: "1rem",
          }}
          dir={language === "ar" ? "rtl" : "ltr"}
          lang={language}
        >
          <TextField
            select
            sx={{
              "& .MuiOutlinedInput-root": {
                backgroundColor: "background.paper",
              },
            }}
            label={t("language")}
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            slotProps={{ select: { native: true } }}
          >
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </TextField>
          <section className="request-card" aria-busy={busy}>
            <h1>{t(view)}</h1>
            {notice && (
              <Alert severity="info" role="status">
                {t(notice)}
              </Alert>
            )}
            {error && <Alert severity="error">{t(error)}</Alert>}
            {account === undefined ? (
              <LoadingStatus label={t("busy")} language={language} />
            ) : view === "signin" ? (
              <Suspense
                fallback={
                  <LoadingStatus label={t("busy")} language={language} />
                }
              >
                <SignInPage
                  providers={credentials}
                  signIn={signIn}
                  slots={{
                    title: omitHeading,
                    subtitle: omitHeading,
                    forgotPasswordLink: SignInLinks,
                  }}
                  localeText={{ providerSignInTitle: () => t("signin") }}
                  slotProps={{
                    forgotPasswordLink: { language, disabled: busy, show, t },
                    form: { className: "request-fields" },
                    emailField: {
                      label: t("loginId"),
                      name: "identifier",
                      type: "text",
                      placeholder: "",
                      autoComplete: "username",
                      autoFocus: false,
                      disabled: busy,
                      slotProps: {
                        htmlInput: { maxLength: 254, dir: "ltr" },
                      },
                    },
                    passwordField: {
                      label: t("password"),
                      placeholder: "",
                      disabled: busy,
                      slotProps: { htmlInput: { maxLength: 128 } },
                    },
                    submitButton: {
                      variant: "contained",
                      color: "primary",
                      disabled: busy,
                      startIcon: null,
                    },
                  }}
                  sx={{
                    minHeight: 0,
                    "& > .MuiContainer-root": { maxWidth: "none", padding: 0 },
                    "& > .MuiContainer-root > .MuiStack-root": {
                      padding: 0,
                      border: 0,
                      boxShadow: "none",
                      background: "transparent",
                    },
                  }}
                />
              </Suspense>
            ) : account && view === "addProfiles" ? (
              <AddProfiles
                account={account}
                language={language}
                t={t}
                onSaved={(updated) => {
                  onAccount(updated);
                  show("account");
                }}
                onCancel={() => show("account")}
              />
            ) : account && view === "verifyPhone" ? (
              <>
                <p>{t("phone_verification_required")}</p>
                {account.pendingPhone && (
                  <p>
                    <bdi>{account.pendingPhone}</bdi>
                  </p>
                )}
                <ReceptionHoursNotice language={language} verification />
                <PatientPhoneVerification
                  language={language}
                  t={t}
                  onVerified={(updated) => {
                    onAccount(updated);
                    show("account");
                    setNotice("phoneVerified");
                  }}
                />
                <div className="request-actions">
                  <Button onClick={() => show("account")}>
                    {t("account")}
                  </Button>
                  <form onSubmit={(event) => submit(event, "guest")}>
                    <Button variant="outlined" type="submit" disabled={busy}>
                      {t("guest")}
                    </Button>
                  </form>
                  <Button onClick={() => show("delete")}>{t("delete")}</Button>
                </div>
              </>
            ) : view === "account" ? (
              <>
                <p>
                  {t("verified")} <bdi>{account.email}</bdi>
                </p>
                {account.username && (
                  <p>
                    {t("username")} <bdi>{account.username}</bdi>
                  </p>
                )}
                {!account.bookingPhone && (
                  <PhoneVerificationNotice language={language} />
                )}
                <div className="request-actions">
                  <Button
                    variant="outlined"
                    onClick={() => show("addProfiles")}
                  >
                    {t("addProfiles")}
                  </Button>
                </div>
                <AccountProfiles account={account} language={language} t={t} />
                <div className="request-actions">
                  <Button
                    variant="outlined"
                    disabled={busy}
                    onClick={() => show("replace-email")}
                  >
                    {t("replace-email")}
                  </Button>
                  <form onSubmit={(event) => submit(event, "signout")}>
                    <Button variant="outlined" type="submit" disabled={busy}>
                      {t("signout")}
                    </Button>
                  </form>
                  {!account.bookingPhone && (
                    <form onSubmit={(event) => submit(event, "guest")}>
                      <Button variant="outlined" type="submit" disabled={busy}>
                        {t("guest")}
                      </Button>
                    </form>
                  )}
                  <Button
                    variant="outlined"
                    disabled={busy}
                    onClick={() => show("delete")}
                  >
                    {t("delete")}
                  </Button>
                </div>
              </>
            ) : (
              <form key={view} className="request-fields" onSubmit={submit}>
                {view === "signup" && (
                  <>
                    <p>{t("signupInfo")}</p>
                    <fieldset className="request-fields" disabled={busy}>
                      <legend>{t("patientDetails")}</legend>
                      <TextField
                        select
                        required
                        size="small"
                        label={t("relationship")}
                        name="relationship"
                        value={relationship}
                        onChange={(event) => {
                          setRelationship(event.target.value);
                          setPatientErrors({});
                        }}
                        helperText={child ? t("childAgeHint") : undefined}
                        slotProps={{
                          select: { native: true },
                          formHelperText: {
                            sx: {
                              color: "#634700",
                              bgcolor: "#fff4cf",
                              alignSelf: "start",
                              px: 0.75,
                              borderRadius: 1,
                            },
                          },
                        }}
                      >
                        <option value="self">{t("self")}</option>
                        <option value="child">{t("child")}</option>
                      </TextField>
                      <PatientDetailsFields
                        details={patient}
                        errors={patientErrors}
                        language={language}
                        edit={editPatient}
                        showPhone={!child}
                        dateAllowed={child ? childBirthDateAllowed : undefined}
                        dateError={
                          child &&
                          patientErrors.dateOfBirth ===
                            "invalid_child_birth_date"
                            ? t("invalid_child_birth_date")
                            : undefined
                        }
                      />
                    </fieldset>
                    <fieldset className="request-fields" disabled={busy}>
                      <legend>{t("accountContact")}</legend>
                      <Field
                        label={t("email")}
                        name="email"
                        type="email"
                        autoComplete="email"
                        dir="ltr"
                        maxLength={254}
                      />
                      {child && (
                        <RequestPhone
                          value={patient.phone}
                          onChange={(value) => editPatient("phone", value)}
                          language={language}
                          error={
                            patientErrors.phone
                              ? t("invalid_account_phone")
                              : undefined
                          }
                          help={t("accountContactHelp")}
                        />
                      )}
                    </fieldset>
                  </>
                )}
                {view === "recover" && (
                  <>
                    <p>{t("recoverInfo")}</p>
                    <Button onClick={() => show("recover-phone")}>
                      {t("recover-phone")}
                    </Button>
                  </>
                )}
                {["recover-phone", "phone-reset"].includes(view) && (
                  <>
                    {view === "recover-phone" && (
                      <ReceptionHoursNotice language={language} verification />
                    )}
                    <Field
                      label={t("phone")}
                      name="phone"
                      type="tel"
                      dir="ltr"
                      autoComplete="tel"
                      maxLength={40}
                    />
                    {view === "phone-reset" && (
                      <Field
                        label={t("phoneCode")}
                        name="code"
                        dir="ltr"
                        autoComplete="one-time-code"
                        maxLength={6}
                      />
                    )}
                    {view === "recover-phone" && (
                      <Button onClick={() => show("phone-reset")}>
                        {t("checkCode")}
                      </Button>
                    )}
                  </>
                )}
                {view === "delete" && <p>{t("deleteInfo")}</p>}
                {view === "replace-email" && <p>{t("replaceInfo")}</p>}
                {view === "activate" && (
                  <>
                    <p>{t("usernameChoices")}</p>
                    <div className="request-actions">
                      {suggestions.map((choice) => (
                        <Button
                          key={choice}
                          variant="outlined"
                          type="button"
                          disabled={busy}
                          onClick={() => setUsername(choice)}
                          sx={{ textTransform: "none" }}
                        >
                          <bdi>{choice}</bdi>
                        </Button>
                      ))}
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setSuggestionRefresh((count) => count + 1)
                        }
                      >
                        {t("usernameRefresh")}
                      </Button>
                    </div>
                    <Field
                      label={t("username")}
                      name="username"
                      dir="auto"
                      maxLength={32}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </>
                )}
                {["recover", "replace-email"].includes(view) && (
                  <Field
                    label={t(view === "replace-email" ? "newEmail" : "email")}
                    name="email"
                    type="email"
                    autoComplete="email"
                    dir="ltr"
                    maxLength={254}
                  />
                )}
                {passwordField && (
                  <Field
                    label={t(newPassword ? "newPassword" : "currentPassword")}
                    name="password"
                    type="password"
                    autoComplete={
                      newPassword ? "new-password" : "current-password"
                    }
                    minLength={newPassword ? 12 : 1}
                    maxLength={128}
                  />
                )}
                <div className="request-actions">
                  <Button variant="contained" type="submit" disabled={busy}>
                    {t(busy ? "busy" : submitLabel)}
                  </Button>
                  <Button
                    variant="outlined"
                    type="button"
                    disabled={busy}
                    onClick={() => show("")}
                  >
                    {t(account ? "cancel" : "back")}
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>
      </ThemeProvider>
    </PublicPage>
  );
}
