// Each list response belongs to exactly one tab/filter/page request. Mutations use
// their own guard, so a slow list cannot block navigation or restore older rows.
export function createRequestListLoader() {
  let generation = 0;
  return {
    invalidate() {
      generation++;
    },
    async load(fetch, view, input, commit, fail, finish) {
      const current = ++generation;
      try {
        const response = await fetch(
          view === "requests" ? "list" : "notices",
          input,
        );
        if (current !== generation) return;
        const rows = view === "requests" ? response.requests : response.notices;
        if (
          !Array.isArray(rows) ||
          rows.some(
            (row) =>
              !row ||
              typeof row.id !== "string" ||
              (view === "requests" && (!row.patient || !row.selection)),
          )
        ) {
          throw new Error(
            "The server returned an unreadable list. Please retry.",
          );
        }
        commit(rows, response.nextCursor ?? null);
      } catch (error) {
        if (current === generation) fail(error);
      } finally {
        if (current === generation) finish();
      }
    },
  };
}
