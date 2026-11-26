import { collectOrder } from "./assistantLab.js";

// Reading what was typed only pre-fills editable fields; staff check them all.
const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function namedTests(text, catalogue) {
  const typed = new Set(words(text));
  return catalogue
    .filter((test) => {
      const short = test.name.match(/\b[A-Z][A-Z0-9]{1,}\b/g) ?? [];
      const name = words(test.name.replace(/\(.*?\)/g, ""));
      return (
        short.some((word) => typed.has(word.toLowerCase())) ||
        (name.length > 0 && name.every((word) => typed.has(word)))
      );
    })
    .map((test) => test._id);
}

export function typedValues(text, fields) {
  return fields.map((field) => {
    const match = new RegExp(
      `(?<![\\p{L}\\p{N}])${escape(field.name)}\\s*(?:[:=]|is\\s)?\\s*([<>]?\\d+(?:[.,]\\d+)?)`,
      "iu",
    ).exec(text);
    return match?.[1] ?? "";
  });
}

// One confirmation: order, collection, results and the draft PDF. It stops
// before finalizing or releasing. A retry resumes the same order.
export function createPrepareRun({ api, patient, testIds, values }) {
  let order;
  return {
    async prepare() {
      try {
        order ??= await api.lab({
          action: "create",
          patientId: patient.id,
          patientRevision: patient.revision,
          testIds,
        });
        if (order.status === "Registered")
          order = await collectOrder(
            {
              lab: async (input) => (order = await api.lab(input)),
            },
            order,
          );
        for (const test of order.tests)
          if (!test.results)
            order = await api.lab({
              action: "results",
              id: order._id,
              revision: order.revision,
              target: test._id,
              results: values[test._id],
            });
        const preview = await api.lab({
          action: "preview-report",
          id: order._id,
          revision: order.revision,
        });
        order = preview.order;
        return preview;
      } catch (error) {
        if (order) error.order = order;
        throw error;
      }
    },
  };
}
