import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";

// Public wording only; the shared Staff/internal defaults are unchanged.
export default function PublicLoadingStatus(props) {
  return (
    <LoadingStatus
      {...props}
      wakeMessage={
        props.language === "ar"
          ? "قد يكون الخادم قيد التشغيل. أبقِ هذه الصفحة مفتوحة؛ بياناتك المدخلة محفوظة."
          : "The server may be waking. Keep this page open; your entered details are retained."
      }
    />
  );
}
