// Deliberately fixed destination. Never accept a renderer-supplied URL.
export function whatsappUrl(phone, message) {
  if (
    typeof phone !== "string" ||
    !/^\+[1-9]\d{6,14}$/.test(phone) ||
    typeof message !== "string" ||
    message.length > 6000
  )
    throw Error("Invalid manual notice.");
  const u = new URL(`https://wa.me/${phone.slice(1)}`);
  u.searchParams.set("text", message);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "wa.me" ||
    u.username ||
    u.password ||
    !/^\/[1-9]\d+$/.test(u.pathname)
  )
    throw Error("Invalid WhatsApp destination.");
  return u.href;
}
