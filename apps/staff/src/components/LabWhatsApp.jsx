import { useState } from "react";
import { labNotice } from "../../shared/lab-notice.js";
import { displayInternationalPhone } from "../../shared/contact-input.js";

export default function LabWhatsApp({ api, order, change, draft }) {
  const [language, setLanguage] = useState("en");
  const [contact, setContact] = useState(null);
  const [contactError, setContactError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const notice = labNotice(order);
  const delivery = notice && order.noticeDelivery?.[notice.id];
  async function readContact() {
    setContact(null);
    setContactError("");
    setConfirmed(false);
    try {
      setContact(
        await api.lab({
          action: "delivery-contact",
          id: order._id,
          revision: order.revision,
        }),
      );
    } catch (error) {
      setContactError(error.message);
    }
  }
  return (
    <details
      className="lab-card"
      onToggle={(event) => {
        if (event.currentTarget.open && notice && !delivery?.sentAt)
          void readContact();
      }}
    >
      <summary>WhatsApp delivery</summary>
      <p>
        Cedar uses the WhatsApp contact on the patient’s record. Send manually
        in WhatsApp.
      </p>
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
              {contactError && (
                <p className="staff-error" role="alert">
                  {contactError}
                </p>
              )}
              {contact && (contact.onHold || !contact.phone) && (
                <p className="staff-warning" role="status">
                  Delivery is on hold. Verify the patient’s WhatsApp contact
                  before sending.
                </p>
              )}
              {contact?.needsConfirmation &&
                contact.phone &&
                !contact.onHold && (
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I confirmed the registered number with the intended
                    recipient.
                  </label>
                )}
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
                disabled={
                  !contact?.phone ||
                  contact.onHold ||
                  (contact.needsConfirmation && !confirmed)
                }
                onClick={() =>
                  change("open-notice", {
                    noticeId: notice.id,
                    language,
                    confirmed,
                  })
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
