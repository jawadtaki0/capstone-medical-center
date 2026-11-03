// Targeted visible UI evidence; no direct booking or queue writes.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function exerciseQueueUI(h) {
  const {
    phone,
    queue,
    booked,
    waiting,
    manage,
    admit,
    fixture,
    evidence,
    date,
    laterDate,
    reopen,
  } = h;
  const p = () => h.getPage(),
    steps = [];
  async function shot(id, operation, observation, assertions = []) {
    await p().locator('.queue-panel[aria-busy="false"]').waitFor();
    await p().evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const screenshot = resolve(evidence, `${id}.png`);
    await p().screenshot({ path: screenshot, fullPage: true });
    steps.push({
      id,
      operation,
      observation,
      automatedAssertions: assertions,
      screenshot,
    });
    await writeFile(
      resolve(evidence, "ui-steps.json"),
      JSON.stringify(
        {
          operator: "Agent via Playwright operating actual package",
          humanManualAcceptance: false,
          testOnly: true,
          date,
          laterDate,
          steps,
        },
        null,
        2,
      ),
    );
    console.log(`UI ${id}: ${observation}`);
  }
  async function button(name) {
    await p().getByRole("button", { name, exact: true }).click();
  }
  const activeName = (name) =>
    p()
      .locator(".queue-active")
      .getByText(`${name} Patient Synthetic`, { exact: true });
  // Only directory/registered patients are fixture-seeded. Reservations use UI.
  await phone("Phonelater", "doctor:synthetic");
  await phone("Phoneone", "doctor:synthetic");
  await phone("Phonemissing", "doctor:synthetic");
  await phone("Phonetwo", "doctor:second");
  await phone("Phonefuture", "doctor:synthetic", "13:00");
  await phone("Full", "doctor:synthetic", "09:00", laterDate);
  await queue();
  assert.equal(await p().locator(".queue-booked tbody tr").count(), 3);
  await shot(
    "01-booked",
    "Six reservations created through packaged booking UI; selected morning session",
    "Three morning bookings unarrived, without queue numbers",
    ["Three selected-session booked rows"],
  );
  await booked("Phoneone").getByRole("button").click();
  await waiting("Phoneone").waitFor();
  await booked("Phonelater").getByRole("button").click();
  await waiting("Phonelater").waitFor();
  assert.match(await waiting("Phoneone").innerText(), /#01/);
  assert.match(await waiting("Phonelater").innerText(), /#02/);
  await shot(
    "02-fcfs",
    "Check in later-booked Phoneone first, earlier-booked Phonelater second",
    "Waiting #01 Phoneone then #02 Phonelater; Phonemissing remains unarrived",
    ["Stable #01/#02 allocated in actual arrival order"],
  );
  await queue();
  assert.match(await waiting("Phoneone").innerText(), /#01/);
  await shot(
    "03-refresh",
    "Refresh selected session through its existing UI loader",
    "Arrival numbers and order retained",
    ["Phoneone remains #01"],
  );
  await queue("doctor:second", "session:second");
  assert.equal(await booked("Phoneone").count(), 0);
  await shot(
    "04-second-professional",
    "Select Dr. Synthetic Second",
    "Only Phonetwo booked here; Review patients absent",
    ["Phoneone absent"],
  );
  await queue("doctor:synthetic", "session:afternoon");
  assert.equal(
    await booked("Phonefuture").getByRole("button").isDisabled(),
    true,
  );
  await shot(
    "05-afternoon",
    "Select Review afternoon session",
    "Only afternoon reservation shown; early check-in disabled",
    ["Row Check in disabled"],
  );
  await queue("doctor:synthetic", "session:synthetic", laterDate);
  assert.equal(await booked("Full").getByRole("button").isDisabled(), true);
  await shot(
    "06-future-date",
    "Select next week's dated session",
    "Only future reservation shown; check-in disabled",
    ["Future row Check in disabled"],
  );
  await queue();
  await manage("Phoneone", "Mark absent");
  const absent = p()
    .locator(".queue-absent tbody tr")
    .filter({ hasText: "Phoneone" });
  await absent.waitFor();
  await shot(
    "07-absent",
    "Phoneone More > Mark absent",
    "Phoneone moved to Temporarily absent with #01 retained",
  );
  await absent
    .getByRole("button", { name: "Returned—join end", exact: true })
    .click();
  await waiting("Phoneone").waitFor();
  assert.match(
    await p().locator(".queue-waiting tbody tr").last().innerText(),
    /#01.*Phoneone/s,
  );
  await shot(
    "08-return",
    "Returned—join end on absent row",
    "#02 Phonelater precedes returning #01 Phoneone",
    ["Last waiting row is Phoneone #01"],
  );
  await p()
    .getByRole("button", { name: /Call next/ })
    .click();
  await activeName("Phonelater").waitFor();
  await shot(
    "09-called",
    "Call next",
    "Phonelater occupies Called slot; Phoneone remains waiting",
  );
  await button("Start consultation");
  await p()
    .getByRole("button", { name: "Complete consultation", exact: true })
    .waitFor();
  await shot(
    "10-consultation",
    "Start consultation",
    "Phonelater is In consultation",
  );
  await button("Complete consultation");
  await button("Completed");
  await p()
    .locator(".queue-history tbody")
    .getByText("Phonelater Patient Synthetic", { exact: true })
    .waitFor();
  await shot(
    "11-completed",
    "Complete consultation; select Completed",
    "Phonelater history completed, active slot empty",
  );
  await manage("Phoneone", "Mark as left");
  await button("Left");
  await p()
    .locator(".queue-history tbody")
    .getByText("Phoneone Patient Synthetic", { exact: true })
    .waitFor();
  await shot(
    "12-left",
    "Phoneone More > Mark as left; select Left",
    "Phoneone appears in Left history",
  );
  await manage("Phoneone", "Correct last change", ".queue-history");
  await p()
    .getByLabel("Reason", { exact: true })
    .fill("Synthetic scenario: departure was entered by mistake");
  await button("Undo departure");
  await waiting("Phoneone").waitFor();
  await shot(
    "13-departure-corrected",
    "Reasoned Undo departure",
    "Phoneone restored to Waiting with stable #01",
  );
  await admit("Walkin");
  await waiting("Walkin").waitFor();
  assert.match(await waiting("Walkin").innerText(), /#03/);
  await shot(
    "14-walk-in",
    "Accept walk-in; select registered TEST Walkin patient",
    "Walkin joins Waiting as #03",
    ["Walkin #03"],
  );
  await admit("Extra", true);
  await waiting("Extra").waitFor();
  assert.match(await waiting("Extra").innerText(), /#04/);
  await shot(
    "15-extra",
    "Admit extra today with reason and fixture professional-agreement assertion",
    "Extra joins as #04; ordinary reservations remain separate",
    ["Extra #04"],
  );
  await p()
    .getByRole("button", { name: /Call next/ })
    .click();
  await activeName("Phoneone").waitFor();
  await queue("doctor:second", "session:second");
  await booked("Phonetwo").getByRole("button").click();
  await waiting("Phonetwo").waitFor();
  assert.match(await waiting("Phonetwo").innerText(), /#01/);
  await p()
    .getByRole("button", { name: /Call next/ })
    .click();
  await activeName("Phonetwo").waitFor();
  assert.equal(
    await fixture.db
      .collection("bookings")
      .countDocuments({ "queue.status": "called" }),
    2,
  );
  await shot(
    "16-parallel-second",
    "Second professional Check in then Call next while Review has Called patient",
    "Second has its own #01 Called, independently",
    ["Two professionals simultaneously have called patients"],
  );
  await button("Start consultation");
  await button("Complete consultation");
  await queue();
  await activeName("Phoneone").waitFor();
  await shot(
    "17-primary-preserved",
    "Return to Review after completing Second's consultation",
    "Phoneone remains Called; Review Waiting #03/#04 preserved",
  );
  await reopen();
  await activeName("Phoneone").waitFor();
  await waiting("Walkin").waitFor();
  await shot(
    "18-reopened",
    "Close/reopen owned TEST package and restart owned TEST API",
    "Called/Waiting/unarrived states persist",
  );
  // Supported injected fixture clock only; OS clock and normal API are untouched.
  fixture.advance(60000);
  await fixture.reconcileQueue();
  await queue();
  await shot(
    "19-session-ended",
    "Advance only supported TEST clock10:59 to11:00; refresh",
    "New arrivals/admissions closed; existing Called and Waiting patients retained",
  );
  await button("No-show");
  const missing = p()
    .locator(".queue-history tbody tr")
    .filter({ hasText: "Phonemissing" });
  await missing.waitFor();
  assert.equal(await missing.locator("td").first().innerText(), "—");
  await shot(
    "20-no-show",
    "Select No-show history",
    "Unarrived Phonemissing has no arrival number/time",
    ["No-show number is dash"],
  );
  await button("Start consultation");
  await button("Complete consultation");
  await button("Completed");
  await p()
    .locator(".queue-history tbody")
    .getByText("Phoneone Patient Synthetic", { exact: true })
    .waitFor();
  await shot(
    "21-after-end-completed",
    "Finish already-called Phoneone after session end",
    "Completed history includes Phoneone; end did not discard prior arrival",
  );
  await button("No-show");
  await manage("Phonemissing", "Correct missed arrival", ".queue-history");
  await p()
    .getByLabel("Reason", { exact: true })
    .fill("Synthetic scenario: staff omitted an arrival before session end");
  await button("Restore to waiting");
  assert.equal(
    await p()
      .locator('.queue-check-in input[type="checkbox"]')
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  await shot(
    "22-correction-required",
    "Try missed-arrival restore without earlier-arrival assertion",
    "Form remains open; required checkbox refuses submission",
    ["Checkbox validity.valueMissing true"],
  );
  await p()
    .getByLabel("I confirm this patient arrived before the session ended", {
      exact: true,
    })
    .check();
  await button("Restore to waiting");
  await waiting("Phonemissing").waitFor();
  assert.match(
    await waiting("Phonemissing").innerText(),
    /#05.*Earlier arrival reported/s,
  );
  const stored = await fixture.db.collection("bookings").find({}).toArray();
  const restored = stored.find(
    (b) => b.queue?.status === "waiting" && b.queue.number === 5,
  );
  assert.ok(restored);
  assert.equal(restored.queue.checkedInAt, undefined);
  assert.equal(
    await fixture.db
      .collection("queue_changes")
      .countDocuments({ action: "no_show" }),
    1,
  );
  await shot(
    "23-missed-arrival-restored",
    "Confirm fixture's earlier arrival and Restore to waiting",
    "Phonemissing appended as #05 with Earlier arrival reported",
    ["No fabricated checkedInAt; original No-show audit retained"],
  );
  await reopen();
  await waiting("Phonemissing").waitFor();
  await shot(
    "24-final-persistence",
    "Reopen TEST package/API after session-end correction",
    "Waiting #03/#04/#05 and corrected arrival survive reopening",
  );
  return steps.length;
}
