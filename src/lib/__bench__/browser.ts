/**
 * Does the application actually run in a browser?
 *
 * ## Why this exists
 *
 * On 2026-08-24 the product was found to have been serving a dead page for its
 * whole life. `next.config.ts` set `script-src 'self'`, Next boots the client
 * from inline `<script>` elements, and the browser refused every one of them.
 * React never hydrated. The status line sat on "Loading...", and choosing a
 * datasheet did nothing at all, because the file input had no handler bound to
 * it. That is the "we cannot upload files" the customer reported.
 *
 * EVERY OTHER INSTRUMENT IN THIS REPO WAS GREEN. `npm test` passed, `tsc`
 * passed, `next build` succeeded, `bench:extraction` reported 52 of 57 parts
 * shipping, and every route answered correctly under `curl`, because a route
 * handler does not care whether a browser ever ran the page that calls it. The
 * gap was not subtle and nothing could see it: no instrument here had ever
 * loaded the app.
 *
 * The same shape then repeated INSIDE the fix. A nonce policy made the dev
 * server work and left the production build dead, because `/` was prerendered
 * at build time and a static page has no request to take a nonce from. Caught
 * only by running this against `npm start`. See `src/app/layout.tsx`.
 *
 * ## What it checks, and what it costs
 *
 * The default pass is FREE and makes no model call. It loads the page, proves
 * it hydrated, and walks the settings screen and the first-run gate, collecting
 * every console error, uncaught exception, failed request and 4xx/5xx along the
 * way. That is enough to catch the entire class above, which is the class that
 * takes the product from working to worthless.
 *
 * `--full` additionally uploads a datasheet and exports a library, which is one
 * real model call and therefore real money. Worth it before a release and not
 * on every change.
 *
 *   npm run build && npm run bench:browser
 *   npm run build && npm run bench:browser -- --full
 *
 * Needs a browser binary once: `npx playwright install chromium`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FULL = process.argv.includes("--full");
/**
 * The datasheets the `--full` pass drives, from the repo's own caches.
 *
 * Several, and deliberately unalike: one path through one document proves that
 * one document works. The review panel only appears when something was read at
 * low confidence or off a drawing, and the question flow only appears when the
 * generator is short a number, so a single well-read part exercises neither.
 */
const PARTS = (process.argv.find((argument) => argument.startsWith("--parts="))?.slice("--parts=".length) ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const ROOT = process.cwd();
/** Not 3000: a dev server is usually already sitting there while working. */
const PORT = Number(process.env.PORT ?? 3210);
const BASE = `http://localhost:${PORT}`;
/**
 * The datasheet to upload, from the repo's own test data.
 *
 * NOT from `.holdout-cache`. Nothing in the hold-out corpus is opened for any
 * purpose, and a UI check is not an exception.
 */
/**
 * A parse takes p50 76s and p90 129s of model time, so every wait here is sized
 * from that rather than picked. A generous timeout costs nothing when a step
 * succeeds and is paid IN FULL every time one fails, which is how a four
 * datasheet run reached half an hour with no way to see where it was.
 */
const PARSE_MS = 180_000;
const EXPORT_MS = 60_000;

/**
 * Two by default, not four.
 *
 * Each datasheet is at least one real model call and often two, since choosing
 * a package can re-read the document. This is meant to be run often, so the
 * default is the smallest set that still covers an upload, a chooser and every
 * format. Go wider deliberately:
 *
 *   npm run bench:browser -- --full --parts=DRV8825,RHF1201,STM32F103C8
 */
const DEFAULT_PDFS = [
  join(ROOT, "test-data", "LMP7704-SP.pdf"),
  join(ROOT, ".bench-cache", "DRV8825.pdf"),
  // A FAMILY DATASHEET, so the package chooser is actually exercised. Without
  // one, `package-chosen` and `re-read-warned` went unreached every run and the
  // screen where 2026-08-24's chooser defect lived was never opened.
  join(ROOT, ".bench-cache", "AD8628.pdf")
];

function datasheets(): string[] {
  const chosen = PARTS.length > 0 ? PARTS.map((name) => join(ROOT, ".bench-cache", `${name}.pdf`)) : DEFAULT_PDFS;
  return chosen.filter((path) => {
    if (existsSync(path)) return true;
    problems.push(`[missing] ${path}`);
    return false;
  });
}

/** Everything the browser complained about, in the order it complained. */
const problems: string[] = [];
/** How many times the page has actually asked the server to build a library. */
let exportRequests = 0;
/** Stages that were supposed to happen. A stage that did not is a failure. */
const reached = new Set<string>();

/**
 * A running log on disk, written synchronously.
 *
 * A `--full` pass takes tens of minutes and Node buffers stdout when it is a
 * pipe, so watching it through `tail` or a task file shows nothing at all until
 * the process exits. That is not a cosmetic problem: it makes a stuck run
 * indistinguishable from a slow one, which is exactly the situation this file
 * exists to stop happening elsewhere.
 */
const LOG = join(ROOT, ".bench-browser.log");

function note(line: string) {
  console.log(line);
  try {
    appendFileSync(LOG, `${line}\n`);
  } catch {
    // A log we cannot write is not a reason to fail the run.
  }
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
        const response = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return true;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /** Waits out the screen's own busy flag rather than a fixed sleep. */
  async function settle(page: import("playwright").Page, timeout: number) {
    await page
      .waitForFunction(() => !document.querySelector("footer.status")?.className.includes("status-busy"), null, {
        timeout
      })
      .catch(() => problems.push("[timeout] the screen never stopped being busy"));
  }

  /**
   * The checks themselves, in their own function so an early bail still reports.
   *
   * Written as a `return` rather than a throw: a page that never rendered has
   * exactly one finding worth printing, and running the rest against it buries
   * that finding under a dozen timeouts for things that were never going to work.
   */
  async function checks(page: import("playwright").Page) {
    // 1. IT HYDRATED. The one check that would have caught the original defect.
    //
    // Asserted through a value only the client can produce: the status line
    // starts as "Loading..." in the server's HTML and is replaced by an effect
    // once React is running. A page that never hydrates keeps the server's.
    await page.goto(BASE, { waitUntil: "networkidle" });

    // Read with a short timeout and REPORT the absence, rather than throwing.
    // A page whose scripts are all refused may never finish streaming its
    // shell, so the status line is not merely stale, it is not there. That is
    // the loudest possible symptom and it deserves a sentence, not a stack.
    const status = await page
      .locator("footer.status")
      .innerText({ timeout: 10_000 })
      .catch(() => null);
    note(`  status after load: ${status === null ? "(the page never rendered one)" : JSON.stringify(status)}`);
    if (status === null) {
      problems.push("[dead] the page never rendered its shell; check the Content-Security-Policy");
    } else if (status.includes("Loading")) {
      problems.push("[dead] the page never hydrated: the client never replaced the server's status line");
    } else {
      reached.add("hydrated");
    }

    // 2. THE FIRST-RUN GATE. A fresh profile has no settings, so it must appear.
    if (await page.locator("#settings-title").isVisible().catch(() => false)) reached.add("settings-shown");
    else problems.push("[gate] a fresh install was not asked for its settings");

    // Nothing below can run on a page that never came up, and forcing it only
    // buries the one finding that matters under a pile of timeouts.
    if (!reached.has("hydrated")) return;

    const numbers = page.locator(".settings input[type=number]");

    // 3. A NUMBER THE EXPORT WOULD REFUSE SAYS SO. It used to vanish in silence.
    await numbers.nth(0).fill("9.5");
    await numbers.nth(1).fill("8");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.waitForTimeout(300);
    const refusal = await page.locator("footer.status").innerText();
    note(`  out-of-range answer: ${JSON.stringify(refusal)}`);
    if (/must be between/.test(refusal)) reached.add("range-explained");
    else problems.push("[silent] an out-of-range setting was dropped without saying why");

    // 4. THE GATE OPENS, AND RUNS WHAT IT TURNED AWAY.
    await numbers.nth(1).fill("1.2");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.waitForTimeout(300);
    if (!(await page.locator("#settings-title").isVisible())) reached.add("settings-saved");
    else problems.push("[gate] complete settings did not open the gate");

    if (!FULL) {
      note("  (skipping the upload and export: --full makes a real model call)");
      return;
    }

    for (const pdf of datasheets()) {
      const name = pdf.split("/").pop();
      note(`\n  --- ${name} ---`);
      try {

      // 5. UPLOAD, THEN START IT. Choosing a file deliberately does NOT begin
      // the read: it takes over a minute and spends a model call, so it is
      // begun by a button. A bench that only set the file would sit waiting for
      // a parse nobody had asked for.
      await page.setInputFiles("#datasheet-upload", pdf);
      await page.waitForTimeout(300);
      const start = page.getByRole("button", { name: "Read this datasheet", exact: true });
      if (!(await start.isVisible().catch(() => false))) {
        problems.push(`[upload] ${name}: choosing a file offered nothing to press`);
        continue;
      }
      reached.add("read-is-explicit");
      await start.click();
      await page.waitForTimeout(400);

      // And it must SAY it is working, in the page rather than only in the
      // status bar: a minute and a half of blank screen reads as a hang.
      if (await page.locator(".working").isVisible().catch(() => false)) {
        reached.add("progress-shown");
      } else {
        problems.push(`[progress] ${name}: nothing on the page said the read had started`);
      }

      await settle(page, PARSE_MS);
      const read = await page.locator("footer.status").innerText();
      note(`  parse: ${JSON.stringify(read)}`);
      // `.result`, the single card that replaced the old identity block and the
      // three numbered steps under it. The bench was still looking for
      // `.identity` and reported "no record was rendered" for a screen that had
      // rendered perfectly, which is the selector going stale rather than the
      // app breaking.
      if (!(await page.locator(".result").isVisible().catch(() => false))) {
        problems.push(`[parse] ${name}: no record was rendered: ${read}`);
        continue;
      }
      reached.add("parsed");

      // THE SCREEN SAYS WHAT HAPPENED AND WHAT TO DO, IN ONE PLACE.
      //
      // A finished read used to arrive as four numbered steps competing for
      // attention, and the first person to use it said "I don't know what I am
      // looking at". There is now exactly one verdict card.
      const verdict = await page.locator(".result-verdict").innerText().catch(() => "");
      if (verdict.trim().length === 0) problems.push(`[verdict] ${name}: the screen states no outcome`);
      else {
        reached.add("verdict-shown");
        note(`  verdict: ${JSON.stringify(verdict.replace(/\s+/g, " ").slice(0, 88))}`);
      }
      if ((await page.locator(".result").count()) !== 1) {
        problems.push(`[verdict] ${name}: expected exactly one result card`);
      }

      // THE SCREEN MUST NOT DISAGREE WITH ITSELF.
      //
      // Both reported 2026-08-25 from one screenshot. A package named "CFP (14)"
      // states a pin COUNT with no table behind it, and the card printed a bare
      // "14" beside a verdict saying the pin names were never read, above a
      // disclosure reading "0 pins". And the one big blue button on the page sat
      // directly under "Not enough was read to build anything", enabled.
      const facts = await page.locator(".identity-facts").innerText().catch(() => "");
      const pinRows = await page.locator("table.pins tbody tr").count();
      const claimsPins = /Pins\s*\n?\s*(\d+)\s*$/m.test(facts);
      if (claimsPins && pinRows === 0 && /no pinout/.test(facts) === false) {
        problems.push(`[verdict] ${name}: the card states a pin count with no pinout behind it`);
      }
      const buildable = await page
        .getByRole("button", { name: "Build library", exact: true })
        .isEnabled()
        .catch(() => false);
      if (buildable && /Not enough was read/i.test(verdict)) {
        problems.push(`[verdict] ${name}: Build is offered under a card saying nothing can be built`);
      }

      // A CARD THAT TELLS YOU TO DO SOMETHING MUST LET YOU DO IT.
      //
      // It said "reading the datasheet again sometimes finds them" and put
      // nothing on screen to do it with, so the only route back was to scroll
      // up and re-pick the same file. Reported 2026-08-25: "what am I supposed
      // to do with this?" The chooser case is exempt because picking a package
      // IS the action, and the cards for it are immediately below.
      if (/Not enough was read/i.test(verdict) && (await page.locator("button.pkg").count()) === 0) {
        const retry = await page
          .getByRole("button", { name: "Read it again", exact: true })
          .isVisible()
          .catch(() => false);
        if (!retry) problems.push(`[verdict] ${name}: the card advises a re-read and offers no way to do it`);
        else reached.add("retry-offered");
      }

      // AND IT IS NOT A WALL.
      //
      // Every outstanding question used to render its own copy of the package
      // outline: eight questions meant eight identical 613px images and a
      // 7118px page that was mostly one picture repeated. The bound is loose on
      // purpose, because a long pin table is legitimate and a repeated drawing
      // is not; it is here to catch the shape coming back, not to police
      // layout.
      const height = await page.evaluate(() => document.body.scrollHeight);
      const drawings = await page.locator(".ask-page img").count();
      note(`  page ${height}px, ${drawings} drawing(s) beside ${await page.locator(".ask-row-full").count()} question(s)`);
      if (height > 5000) problems.push(`[wall] ${name}: the page is ${height}px tall after a read`);
      else reached.add("not-a-wall");

      // 6. THE REVIEW PANEL. Confirming and correcting are separate paths and
      // each writes a different provenance onto the record, so both are driven
      // wherever the document offers an item to drive them with.
      // THE PANEL FOLDS ITSELF NOW, so it has to be opened before its rows can
      // be clicked. It is a `<details>` that starts closed unless something is
      // blocking: thirteen items on this part, none of them stopping an export.
      // Left shut, every click below waited out its own timeout and the run
      // reported two crashes that were the bench knocking on a closed door.
      const fold = page.locator("details.reviews-fold");
      if ((await fold.count()) > 0 && !(await fold.first().evaluate((el) => (el as HTMLDetailsElement).open))) {
        await fold.first().locator("summary").click();
        await page.waitForTimeout(400);
      }

      const reviews = page.locator("button.rev-head");
      const reviewCount = await reviews.count();
      note(`  review items: ${reviewCount}`);
      if (reviewCount > 0) {
        await reviews.first().click();
        await page.waitForTimeout(300);
        const confirm = page.getByRole("button", { name: "Correct as read", exact: true }).first();
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click();
          await page.waitForTimeout(300);
          reached.add("review-confirmed");
          note(`  confirmed: ${JSON.stringify(await page.locator("footer.status").innerText())}`);
        } else {
          problems.push(`[review] ${name}: an item opened with no way to confirm it`);
        }

        // A CORRECTION IS EXERCISED ONLY ON A MILLIMETRE FIELD, AND SET TO THE
        // VALUE ALREADY SHOWN.
        //
        // The point is to exercise the path, not to invent data. Two earlier
        // versions of this corrupted the record instead. Typing a
        // plausible-looking 1.27 into whatever item came first put it into PIN
        // COUNT, the pin table collapsed to one pin, and both exports refused
        // with a perfectly correct message about the pinout not matching a
        // 28-lead package. Typing back the displayed value with the units
        // stripped turned a package named "14-pin CFP" into "14".
        //
        // Both times the bench manufactured a failure and reported it as the
        // product's. So the target is now restricted to an item whose displayed
        // value IS a number in millimetres, where writing that same number back
        // is a no-op, and where there is no text to mangle. If no such item is
        // offered, the path goes unexercised and is reported as such, which is
        // the honest outcome rather than a forced one.
        const values = await page.locator(".rev-value").allInnerTexts();
        const target = values.findIndex((value) => /^\s*[\d.]+\s*mm\s*$/.test(value));
        if (target >= 0) {
          await reviews.nth(target).click();
          await page.waitForTimeout(300);
          const same = values[target].replace(/[^0-9.]/g, "");
          const box = page.locator(".rev-correct input").first();
          if (await box.isVisible().catch(() => false)) {
            await box.fill(same);
            await page.getByRole("button", { name: "Set", exact: true }).first().click();
            await page.waitForTimeout(400);
            reached.add("review-corrected");
            note(`  corrected: ${JSON.stringify(await page.locator("footer.status").innerText())}`);
          }
        } else {
          note("  (no millimetre item offered, so the correction path is untested here)");
        }
      }

      // 7. THE PACKAGE CHOOSER, where the document offers a choice.
      const packages = page.locator("button.pkg");
      const packageCount = await packages.count();
      if (packageCount > 0) {
        note(`  packages offered: ${packageCount}`);
        let index = 0;
        for (let i = 0; i < packageCount; i++) {
          if ((await packages.nth(i).innerText()).includes("builds now")) {
            index = i;
            break;
          }
        }

        // A CLICK THAT RE-READS THE DOCUMENT MUST SAY SO ON THE CARD.
        //
        // Choosing a package takes one of three routes and only one of them
        // re-reads, which is upward of a minute and a charged model call. Which
        // route depends on whether the document tabulated that package's pinout,
        // and the user cannot see that. Found 2026-08-24: on an AD8628, TSOT-23
        // and SOT-23 are both labelled "cannot build", one is free and the other
        // re-reads. The card now carries the warning, and the check here is that
        // the warning and the behaviour still agree.
        const warned = (await packages.nth(index).innerText()).includes("re-reads the datasheet");
        const startedAt = Date.now();
        await packages.nth(index).click();
        await settle(page, PARSE_MS);
        // The chooser rewrites the record and the export section re-renders off
        // it. Clicking Build into that re-render did nothing, and the bench
        // reported it as a failed export when a hand-driven browser exports
        // fine. Wait for the button rather than racing the frame.
        await page.waitForTimeout(1500);
        await page
          .getByRole("button", { name: "Build library", exact: true })
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => {});
        const reRead = Date.now() - startedAt > 10_000;
        if (reRead !== warned) {
          problems.push(
            `[chooser] ${name}: the card ${warned ? "warns of a re-read that did not happen" : "re-read the datasheet with no warning on it"}`
          );
        }
        if (warned) reached.add("re-read-warned");
        reached.add("package-chosen");
      }

      // 8. THE QUESTION FLOW. A refusal the user can ANSWER is a different thing
      // from one they cannot, and the answering half had never been exercised.
      const asks = page.locator(".ask input");
      const askCount = await asks.count();
      if (askCount > 0) {
        note(`  questions asked: ${askCount}`);
        for (let i = 0; i < askCount; i++) {
          const input = asks.nth(i);
          await input.fill((await input.getAttribute("type")) === "number" ? "1.55" : "2");
        }
        const answer = page.getByRole("button", { name: "Use this", exact: true }).first();
        if (await answer.isVisible().catch(() => false)) {
          await answer.click();
          await settle(page, PARSE_MS);
        }
        reached.add("question-answered");
      }

      // 9. EVERY FORMAT THAT CLAIMS TO BE READY, not just the default.
      //
      // Each has its own generator over the same geometry. Exporting KiCad alone
      // and reporting that export works is the same mistake as one datasheet.
      const readyLabels = page.locator(".formats label:not(.fmt-off)");
      const formatCount = await readyLabels.count();
      for (let i = 0; i < formatCount; i++) {
        const label = (await readyLabels.nth(i).innerText()).split("\n")[0].trim();
        // A DOM click on the input itself. The radio is visually hidden inside
        // its label and the sticky status footer covers the bottom of the page,
        // so Playwright's `check()` either refuses on actionability or, forced,
        // reports "clicking the checkbox did not change its state". Neither is
        // a defect in the app: a real pointer lands on the label.
        await readyLabels
          .nth(i)
          .locator("input[type=radio]")
          .evaluate((element) => (element as HTMLInputElement).click());
        await page.waitForTimeout(200);

        const build = page.getByRole("button", { name: "Build library", exact: true });
        if (!(await build.isEnabled())) {
          // A DISABLED BUTTON UNDER A REFUSING VERDICT IS CORRECT.
          //
          // The build action is withheld when the reading is short of something
          // no choice on the screen can supply, because pressing it could only
          // produce a refusal. That is the fix for "the one big blue button sat
          // under a card saying nothing can be built", so the bench must not
          // then report the fix as a fault. Withheld for any OTHER reason is
          // still a finding.
          if (/Not enough was read/i.test(verdict)) {
            note(`  ${label}: withheld, and the card says why. Correct.`);
            reached.add("build-withheld-honestly");
          } else {
            problems.push(`[export] ${name}: the build button never became available`);
          }
          continue;
        }
        const requestsBefore = exportRequests;
        const download = page.waitForEvent("download", { timeout: EXPORT_MS }).catch(() => null);

        // A DOM CLICK, AND CONFIRMED TO HAVE LANDED.
        //
        // A coordinate click has to hit-test against a layout that has just
        // re-rendered from a correction or a package choice, and it silently
        // does nothing when it loses that race. That produced "PRESSING BUILD
        // SENT NO REQUEST" on two of three datasheets while the third passed
        // and while the same sequence driven by hand exported every time. The
        // app was right and the bench was flaky, which is worse than a bench
        // that fails honestly: it sent me looking for a defect that was not
        // there, twice.
        //
        // `el.click()` dispatches straight to the node, so there is no
        // coordinate and nothing to occlude it. The request counter then says
        // whether React actually ran the handler; a real failure still fails,
        // because it fails BOTH times.
        for (let attempt = 0; attempt < 2 && exportRequests === requestsBefore; attempt += 1) {
          if (attempt > 0) await page.waitForTimeout(1200);
          await build.evaluate((element) => (element as HTMLButtonElement).click());
          await page.waitForTimeout(600);
        }
        await settle(page, EXPORT_MS);
        // The screen going quiet is the real signal, so a REFUSAL costs a few
        // seconds rather than the full download timeout. Waiting out 60s per
        // refused format, twice per datasheet, was most of this bench's runtime
        // and none of its findings.
        const file = await Promise.race([
          download,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))
        ]);
        const outcome = await page.locator("footer.status").innerText();
        if (file) {
          reached.add(`exported:${label.toLowerCase()}`);
          note(`  ${label}: ${await file.suggestedFilename()}`);
        } else if (/needed|missing|cannot|refus/i.test(outcome)) {
          // A refusal the product MEANS is not a browser failure. Recorded, and
          // not counted as an export.
          note(`  ${label}: refused, ${JSON.stringify(outcome)}`);
          // BUT THE CARD MUST NOT HAVE PROMISED OTHERWISE.
          //
          // On 2026-08-25 the verdict read "Ready to build" and both formats
          // then refused with "this datasheet is missing values the footprint
          // needs". The card is the first thing a person reads and the button
          // is the next thing they press; the two disagreeing spends their
          // trust and then their time.
          const promised = await page.locator(".result-verdict").innerText().catch(() => "");
          if (/ready to build/i.test(promised)) {
            problems.push(`[verdict] ${name}: the card said "Ready to build" and ${label} then refused: ${outcome}`);
          }
        } else if (exportRequests === requestsBefore) {
          problems.push(
            `[export] ${name} as ${label}: PRESSING BUILD SENT NO REQUEST. status was ${JSON.stringify(outcome.slice(0, 70))}`
          );
        } else {
          problems.push(`[export] ${name} as ${label}: the server was asked and nothing came back. ${outcome}`);
        }
      }

      // 9b. NOTHING SCROLLS SIDEWAYS ON A PHONE.
      //
      // A REAL viewport, not a width forced onto the root element. The first
      // version of this check set `documentElement.style.width = "390px"` and
      // measured `scrollWidth`, which reports the content laid out at the
      // original width and produced "890px wider than a phone screen" on a page
      // that a genuine 390px viewport renders with zero overflow. The bench was
      // wrong and the app was fine, which is the second time in two days an
      // instrument here has reported its own defect as the product's.
      // MEASURED TWICE, because a resize is not instant. Reading immediately
      // after `setViewportSize` catches the page mid-reflow: that reported
      // "8px wider than a phone" on a layout which, loaded at 390px from the
      // start, overflows by exactly zero. Two readings that agree are a real
      // overflow; two that differ are the browser still working.
      const desktop = page.viewportSize() ?? { width: 1280, height: 900 };
      await page.setViewportSize({ width: 390, height: 780 });
      const measure = async () => {
        await page.waitForTimeout(500);
        return page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
      };
      const first = await measure();
      const second = await measure();
      const overflow = first === second ? second : 0;
      await page.setViewportSize(desktop);
      await page.waitForTimeout(300);
      if (overflow > 2) problems.push(`[narrow] ${name}: the page is ${overflow}px wider than a phone screen`);
      else reached.add("fits-a-phone");

      // A format the product says is not built must not be offered as buildable.
      if ((await page.locator(".formats label.fmt-off input[type=radio]").count()) > 0) {
        reached.add("unready-format-disabled");
      }
    } catch (error) {
      // Recorded and carried on. A bench that stops at its first finding
      // reports exactly one finding, however many there are.
      problems.push(`[crash] ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  // 10. THE LOOKUP BOX, the second door into the same parse code, never opened
  // by anything before now. Present only in commercial mode.
  const lookup = page.locator(".lookup input").first();
  if (await lookup.isVisible().catch(() => false)) {
    await lookup.fill("LM358");
    await page.getByRole("button", { name: "Find datasheet", exact: true }).click();
    await page.waitForTimeout(500);
    await settle(page, PARSE_MS);
    const outcome = await page.locator("footer.status").innerText();
    note(`\n  lookup LM358: ${JSON.stringify(outcome)}`);
    // A lookup that finds nothing is a real answer about the internet rather
    // than a frontend defect, so the check is that it RAN and said something.
    if (outcome.length > 0 && !/^Loading/.test(outcome)) reached.add("lookup-ran");
    else problems.push("[lookup] the lookup box did nothing");
  }
}

async function main() {
  try {
    writeFileSync(LOG, `browser bench, ${new Date().toISOString()}, full=${FULL}\n`);
  } catch {
    // As above.
  }
  if (!existsSync(join(ROOT, ".next"))) {
    console.error("No .next directory. Run `npm run build` first: this checks the PRODUCTION build,");
    console.error("because the defect it exists for was invisible in `next dev`.");
    process.exit(2);
  }

  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    console.error("playwright is not installed. `npm i -D playwright && npx playwright install chromium`");
    process.exit(2);
  }

  let server: ChildProcess | undefined;
  let browser: import("playwright").Browser | undefined;
  try {
    note(`Starting the production server on ${PORT}...`);
    // THE SERVER'S OWN LOG, KEPT.
    //
    // This was `stdio: "ignore"`, so when a route threw, the bench saw a failed
    // click and the stack trace went nowhere. The Altium 500 on 2026-08-24 was
    // found by reading a dev server log, and this bench could not have found
    // it. Anything the server says now lands beside the run.
    const serverLog = openSync(join(ROOT, ".bench-browser-server.log"), "w");
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      cwd: ROOT,
      stdio: ["ignore", serverLog, serverLog],
      env: { ...process.env, PORT: String(PORT) }
    });
    if (!(await waitForServer(60_000))) {
      console.error("The production server never came up.");
      process.exit(2);
    }

    try {
      browser = await playwright.chromium.launch();
    } catch (error) {
      console.error("Could not launch a browser. `npx playwright install chromium`");
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    page.on("console", (message) => {
      // The browser logs a console error for every non-2xx response, including
      // the 422 above, which is not the page doing anything wrong.
      const text = message.text();
      if (message.type() !== "error") return;
      if (/Failed to load resource.*422/.test(text)) return;
      problems.push(`[console] ${text}`);
    });
    page.on("pageerror", (error) => problems.push(`[uncaught] ${error.message}`));
    // Counted, because "the export did not happen" and "the export happened and
    // failed" are different defects and the status line alone cannot tell them
    // apart. Chasing one as the other cost most of a night.
    page.on("request", (request) => {
      if (request.url().includes("/api/export")) exportRequests += 1;
    });
    page.on("requestfailed", (request) => {
      problems.push(`[blocked] ${request.url()} :: ${request.failure()?.errorText}`);
    });
    page.on("response", (response) => {
      // A 422 FROM `/api/export` IS A DESIGNED ANSWER, not a fault. It is how
      // the route says "these values are missing and you can supply them", and
      // the screen turns it into the question flow. Counting it as a browser
      // problem reports the product's honesty as a defect. Any OTHER 4xx or 5xx
      // is still a finding, and an export that refuses for a reason the screen
      // does not handle is caught below by its outcome rather than its status.
      const designedRefusal = response.status() === 422 && response.url().endsWith("/api/export");
      if (response.status() >= 400 && !designedRefusal) {
        problems.push(`[http ${response.status()}] ${response.url()}`);
      }
    });

    await checks(page);
  } finally {
    await browser?.close();
    server?.kill("SIGKILL");
  }

  // What MUST happen, kept apart from what a document merely happens to offer.
  //
  // The review panel, the question flow and the chooser only appear where the
  // datasheet produces them, so a run that never sees one is not a failure. It
  // is still printed, because a set of datasheets that quietly stops exercising
  // a path leaves that path unchecked while this bench goes on saying OK.
  const required = FULL
    ? [
        "hydrated",
        "settings-shown",
        "range-explained",
        "settings-saved",
        "read-is-explicit",
        "progress-shown",
        "parsed",
        "exported:kicad",
        "exported:altium",
        "fits-a-phone",
        "verdict-shown",
        "not-a-wall"
      ]
    : ["hydrated", "settings-shown", "range-explained", "settings-saved"];
  const optional = FULL
    ? [
        "review-confirmed",
        "review-corrected",
        "package-chosen",
        "re-read-warned",
        "question-answered",
        "lookup-ran",
        "unready-format-disabled"
      ]
    : [];
  const missed = required.filter((stage) => !reached.has(stage));

  console.log("");
  console.log(`Required stages: ${required.length - missed.length}/${required.length}`);
  if (missed.length > 0) console.log(`  never reached: ${missed.join(", ")}`);
  if (optional.length > 0) {
    const seen = optional.filter((stage) => reached.has(stage));
    console.log(`Paths these datasheets exercised: ${seen.length}/${optional.length}`);
    const unseen = optional.filter((stage) => !reached.has(stage));
    if (unseen.length > 0) console.log(`  NOT exercised by this run: ${unseen.join(", ")}`);
  }
  console.log(`Browser problems: ${problems.length}`);
  for (const problem of [...new Set(problems)]) console.log(`  ${problem}`);

  if (missed.length > 0 || problems.length > 0) {
    console.log("");
    console.log("FAIL. The app does not run clean in a browser.");
    process.exit(1);
  }
  console.log("");
  console.log("OK. The app loads, hydrates and runs with no browser errors.");
}

// Not top-level `await`: the other benches here run under tsx's CJS output,
// which has no such thing. `void` because the process exits from inside.
void main();
