import { useState } from "react";
import { labNotice } from "../../shared/lab-notice.js";
import { displayInternationalPhone } from "../../shared/contact-input.js";
import PhoneInput from "./PhoneInput.jsx";

export default function LabWhatsApp({ order, change, draft }) {
  const [language, setLanguage] = useState("en");
  const [phone, setPhone] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const notice = labNotice(order);
  const delivery = notice && order.noticeDelivery?.[notice.id];
  return (
    <details className="lab-card">
      <summary>WhatsApp delivery</summary>
      <p>Reception sends manually. Opening a draft leaves it pending.</p>
      <PhoneInput
        label="Contact number"
        defaultValue=""
        onValueChange={(value) => {
          setPhone(value ?? "");
          setConfirmed(false);
        }}
      />
      <button
        className="staff-button"
        disabled={!phone.trim()}
        onClick={() => change("contact-pending", { phone })}
      >
        Hold delivery pending verification
      </button>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I verified possession of the pending number with the intended contact.
      </label>
      <button
        className="staff-button"
        disabled={!phone.trim() || !confirmed}
        onClick={() => change("contact-confirm", { phone, confirmed })}
      >
        Confirm verified contact
      </button>
      {notice && (
        <>
          <h3>
            {
              {
                recollection: "Recollection",
                cancellation: "Cancellation",
                release: "Release",
                withdrawal: "Withdrawal",
                corrected: "Corrected release",
              }[notice.kind]
            }{" "}
            · {delivery?.sentAt ? "Sent" : "Pending"}
          </h3>
          {delivery?.sentAt ? (
            <p>Confirmed sent {new Date(delivery.sentAt).toLocaleString()}.</p>
          ) : (
            <>
              <label>
                Message language{" "}
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
              <button
                className="staff-button"
                onClick={() =>
                  change("open-notice", { noticeId: notice.id, language })
                }
              >
                Open WhatsApp draft
              </button>
              {draft?.order?.revision === order.revision &&
                draft?.message &&
                (!notice.report || draft.fileSaved) && (
                  <div>
                    <p role="status">
                      Draft prepared for{" "}
                      <bdi>{displayInternationalPhone(draft.phone)}</bdi>.
                    </p>
                    <p dir="auto">{draft.message}</p>
                    {draft.filename && (
                      <p>Attach the exact saved report: {draft.filename}</p>
                    )}
                    <button
                      className="staff-button"
                      onClick={() =>
                        change("mark-notice-sent", { noticeId: notice.id })
                      }
                    >
                      Mark sent
                    </button>
                  </div>
                )}
            </>
          )}
        </>
      )}
    </details>
  );
}
