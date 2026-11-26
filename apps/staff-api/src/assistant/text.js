// Arabic letters that are commonly typed several ways, and diacritics.
export const plain = (text) =>
  text
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .toLowerCase();
