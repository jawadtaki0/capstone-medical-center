const status = document.getElementById("status");
const label = document.getElementById("status-label");
let currentStep = -1;
const button = document.getElementById("cancel");
const steps = [
  document.getElementById("database"),
  document.getElementById("server"),
  document.getElementById("application"),
];
const names = [
  "Checking database",
  "Checking staff server",
  "Opening Cedar Staff",
];
function show(value) {
  if (!value || typeof value.message !== "string") return;
  if (label.textContent !== value.message) label.textContent = value.message;
  const index = names.indexOf(value.message);
  const active = value.type === "progress" && index >= 0;
  status.dataset.active = String(active);
  if (active && currentStep !== index) {
    label.classList.remove("step-enter");
    // Restart the one-shot fade only for a different startup step, not polling.
    void label.offsetWidth;
    label.classList.add("step-enter");
    currentStep = index;
  } else if (!active) label.classList.remove("step-enter");
  if (index >= 0 || value.type === "complete")
    steps.forEach((step, position) => {
      step.dataset.state =
        value.type === "complete" || position < index
          ? "done"
          : position === index
            ? "current"
            : "waiting";
      step.setAttribute(
        "aria-label",
        `${["Database", "Staff server", "Application"][position]}: ${step.dataset.state === "done" ? "completed" : step.dataset.state}`,
      );
      if (active && position === index)
        step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  if (!active) steps.forEach((step) => step.removeAttribute("aria-current"));
  button.disabled =
    value.type === "complete" ||
    value.message === "Opening Cedar Staff" ||
    value.message.startsWith("Cancelling");
  if (value.type === "failure") {
    document.body.dataset.failed = "true";
    document.getElementById("heading").textContent =
      "Startup could not complete";
    status.setAttribute("role", "alert");
    button.textContent = "Close";
    button.disabled = false;
    button.focus();
  }
}
window.cedarLauncher.status(show);
window.cedarLauncher
  .ready()
  .then(show)
  .catch(() =>
    show({
      type: "failure",
      message:
        "The local launcher is unavailable. Close this window and retry.",
    }),
  );
button.addEventListener("click", () => {
  void window.cedarLauncher.cancel();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !button.disabled) {
    event.preventDefault();
    void window.cedarLauncher.cancel();
  }
});
button.focus();
