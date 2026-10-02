"use strict";

// Persistent browser worker for Betfair Sportsbook betslips. Two modes,
// selected per-request by the caller's dry_run flag: dry-run (default)
// prepares the betslip/stake and never submits — the network route-guard
// aborts every placement POST; real placement (dry_run=false, gated in
// server.py behind ROBINARB_BETFAIR_LIVE_PLACE_ENABLED) additionally clicks
// the Place Bet button and confirms the receipt/error, with the network
// guard disarmed only for that narrow click+result-wait window.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  placeBetButtonRegex,
  isReceiptText,
  isBetslipErrorText,
} = require("./betfair_sportsbook_button_match.cjs");
const {
  collectRunnerObjects,
  collectRunnerContexts,
  marketIdentityPlausible,
  handicapPlausible,
  isUsableNumeric,
  lineVerificationRequired,
  selectFreshMatchingRunners,
  eventParticipantsFromUrl,
  eventSearchScore,
} = require("./betfair_sportsbook_market_identity.cjs");
const { runPlaceBetClick } = require("./betfair_sportsbook_place_click.cjs");
const {
  MARKET_CONTAINER_SELECTOR,
  climbToMarketContainer,
  buildScanIdSelector,
} = require("./betfair_sportsbook_market_boundary.cjs");
const {
  isOddsButtonText,
  oddsEquivalent,
  canonicalOutcomeKey,
  outcomeKeysEqual,
  findAdjacentOddsButton,
} = require("./betfair_sportsbook_selection_match.cjs");
// Reconcile Фаза2: Фаза1's structural forted<->betfair market-header matcher
// replaces the narrow exact-string `marketNameFallbacks`/
// `findExactMarketHeaderIndices` whitelist as the ONLY matching path -- both
// for the legacy DOM /basket flow (clickExactSelection) and the request-only
// catalog resolver (resolveMarket) below.
const {
  matchMarketHeader,
  parseMarketIdentity,
  SELECTION_ENRICHABLE_FAMILIES,
} = require("./betfair_sportsbook_market_match.cjs");
const {
  resolveCatalogMarketCard,
  resolveCatalogRunner,
  catalogLineEvidenceOk,
  verifyCatalogMarketOwnership,
  isCatalogResolutionFailureTerminal,
} = require("./betfair_sportsbook_catalog_resolve.cjs");
const { LIVE_PLACE_ENV_VAR, liveBetfairPlaceEnabled } = require("./betfair_sportsbook_live_gate.cjs");
// Reconcile regress1 P1-1 (money-critical, final cross-family audit fix):
// pure exhaustive-scan merge helper -- see its own doc comment and
// betfair_sportsbook_lazy_scan.cjs's module comment for the exact bug this
// closes (a page-wide duplicate market in a not-yet-rendered lazy-scroll
// viewport was never provably ruled out by the old per-viewport break).
const { resolveLazyScanMatch, assertScanReachedEnd } = require("./betfair_sportsbook_lazy_scan.cjs");
const {
  findUniqueBetRecord,
  findUniqueBetByIntent,
  placedResult,
  unknownResult,
} = require("./betfair_sportsbook_reconcile.cjs");

const HOST = "127.0.0.1";
const PORT = Number(process.env.BETFAIR_SPORTSBOOK_BASKET_PORT || 8898);
const PROFILE_DIR = process.env.BETFAIR_SPORTSBOOK_PROFILE_DIR
  || path.join(process.cwd(), "backend", "stats_data", "betfair-sportsbook-profile");
const SCREENSHOT_DIR = process.env.BETFAIR_SPORTSBOOK_SCREENSHOT_DIR
  || path.join(process.cwd(), "backend", "stats_data", "betfair-sportsbook-baskets");
const FIXED_ODDS_APP_KEY = process.env.BETFAIR_SPB_APP_KEY || "K61C39rIC0WKzoQ7";
const FIXED_ODDS_URLS = {
  imply: `https://sib.betfair.com/www/sports/fixedodds/transactional/v1/implyBets?_ak=${FIXED_ODDS_APP_KEY}`,
  prices: `https://smp.betfair.com/www/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=1&_ak=${FIXED_ODDS_APP_KEY}`,
  place: `https://spb.betfair.com/www/sports/fixedodds/transactional/v1/placeBet?_ak=${FIXED_ODDS_APP_KEY}`,
};

// Reconcile regress1 P1-2 (money-critical, final cross-family audit fix):
// distinguishes a DEFINITIVE semantic rejection by resolveMarket()'s strict
// catalog matcher/evidence gates (ambiguous URN, runner not-active/
// ambiguous, ownership urn mismatch, all-blind line evidence) from an INFRA
// failure (login/transport/malformed-response, safe to retry via a
// different resolution path). The /resolve-market HTTP handler reports
// MarketSemanticRejectError instances with a distinct `status:
// "MARKET_REJECTED"` (never "MARKET_RESOLVE_FAILED") so
// betfair_sportsbook_place_api.py's resolve_market() can raise a distinct,
// non-retriable error code -- server.py's _place_betfair_via_api must NOT
// fall back to the permissive DOM basket path on a semantic reject: DOM's
// separate matcher re-resolving the same ambiguous/rejected selection is
// exactly how a wrong same-named market/runner could get placed live.
class MarketSemanticRejectError extends Error {}

let context = null;
let page = null;
let queue = Promise.resolve();
let lastResult = null;
let lastError = "";
let blockedSubmitCount = 0;
let activeRequestDryRun = true;

// Diagnostic capture (Story 2.2): when BETFAIR_CAPTURE_PLACEMENT=1 the worker
// records the full HTTP placement request (method/url/headers/postData) that
// the Sportsbook UI fires on "Place Bet", then blocks it (no real money spent),
// so the contract can be reproduced by a direct API client.
const CAPTURE_PLACEMENT = String(process.env.BETFAIR_CAPTURE_PLACEMENT || "").trim() === "1";
const CAPTURE_FILE = process.env.BETFAIR_CAPTURE_FILE
  || path.join(SCREENSHOT_DIR, "placement-capture.jsonl");

// Story 2.2: exports the persistent profile's live session cookies so the
// direct HTTP API client (betfair_sportsbook_place_api.py) can reuse this
// browser's already-logged-in Betfair session instead of logging in again.
// Returns null when the profile has no Betfair cookies yet (never logged in).
async function sessionCookies() {
  await ensureBrowser();
  const cookies = await context.cookies();
  const relevant = cookies.filter((c) => String(c.domain || "").toLowerCase().includes("betfair.com"));
  if (!relevant.length) return null;
  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

function isBetfairSportsbookApi(request) {
  const url = request.url().toLowerCase();
  return url.includes("spb.betfair.com") || url.includes("/www/sports/fixedodds/");
}

// Story 2.2b: wider capture — any Betfair fetch/xhr API call (not just the
// placement endpoints), so the markets-by-event catalog request fired while
// loading an event page can be found and reproduced for betfair market_id
// resolution. Static assets (images/css/scripts) are excluded by resourceType.
function isBetfairApiXhr(request) {
  const rt = request.resourceType();
  if (rt !== "fetch" && rt !== "xhr") return false;
  const host = (() => { try { return new URL(request.url()).hostname.toLowerCase(); } catch { return ""; } })();
  return host.endsWith("betfair.com");
}

function captureRequest(request, tag) {
  try {
    const rec = {
      tag,
      captured_at: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      post_data: request.postData(),
      resource_type: request.resourceType(),
    };
    fs.mkdirSync(path.dirname(CAPTURE_FILE), { recursive: true });
    fs.appendFileSync(CAPTURE_FILE, JSON.stringify(rec) + "\n");
  } catch (e) {
    process.stderr.write(`capture error: ${e && e.message}\n`);
  }
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function parseProxy(raw) {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  const parts = value.split(":");
  if (parts.length < 2) throw new Error("Invalid BETFAIR_PROXY format");
  return {
    server: `http://${parts[0]}:${parts[1]}`,
    username: parts[2] || undefined,
    password: parts.slice(3).join(":") || undefined,
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function safeId(value) {
  return String(value || "betfair-sportsbook")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .slice(0, 100);
}

function isPlacementRequest(request) {
  if (request.method() !== "POST") return false;
  const url = request.url().toLowerCase();
  if (url.includes("identitysso.betfair.com/api/login")) return false;
  if (url.includes("/imply")) return false;
  return /place[-_\/]?bets?|bet[-_\/]?placement|submit[-_\/]?bets?|\/transactions?(?:\/|\?|$)/i.test(url);
}

function isExplicitDryRunPlacement(request) {
  try {
    return JSON.parse(request.postData() || "{}").dryRun === true;
  } catch {
    return false;
  }
}

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return page;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const proxy = parseProxy(process.env.BETFAIR_PROXY || process.env.PADDY_SPORTSBOOK_PROXY);
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    proxy,
    viewport: { width: 1440, height: 1000 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (CAPTURE_PLACEMENT && isBetfairApiXhr(req) && !isPlacementRequest(req)) {
      // Log every Betfair fetch/xhr (prices/betslip/markets-by-event/catalog),
      // let it through. Tag known fixed-odds endpoints distinctly for clarity.
      captureRequest(req, isBetfairSportsbookApi(req) ? "api" : "xhr");
      await route.continue();
      return;
    }
    if (isPlacementRequest(req)) {
      if (CAPTURE_PLACEMENT) {
        // Record the placeBet contract and block (no real bet placed).
        captureRequest(req, "placeBet");
        blockedSubmitCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      if (isExplicitDryRunPlacement(req)) {
        await route.continue();
        return;
      }
      if (activeRequestDryRun) {
        blockedSubmitCount += 1;
        await route.abort("blockedbyclient");
      } else {
        await route.continue();
      }
      return;
    }
    await route.continue();
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(12000);
  return page;
}

// Reconcile Фаза2 task 5 ("Resolve contract"): true when `marketName`'s
// structural family is a LINE-BEARING one (handicap*/total*/playerTotal/
// setTotal/matchTotal -- the same family set betfair_sportsbook_market_
// match.cjs's own enrichWithSelectionLine gates on, reused here rather than
// duplicated so the two can never silently disagree on which families carry
// a line at all). Moneyline/set_winner and anything the structural parser
// cannot classify are NOT considered line-bearing (fail-open: an unknown
// family cannot be asserted to require expected_line).
function isLineBearingMarketName(marketName, marketType) {
  const identity = parseMarketIdentity(marketName, { marketType });
  return Boolean(identity.marketType) && SELECTION_ENRICHABLE_FAMILIES.has(identity.marketType);
}

// Reconcile Фаза2 task 5: accepts the split `selection` (bare runner name) /
// `selection_label` (line-enriched intent) / `expected_line` (already-
// verified numeric line) contract spec-B calls for, while falling back to
// TODAY's single `selection` field for full backward compatibility --
// server-side wiring of these new fields is explicitly Фаза3, not here.
//
//   - `selection` remains the bare identity field, unchanged in meaning and
//     validation from before this Фаза.
//   - `selectionLabel` is what matching/DOM-clicking use as the "wanted"
//     text (the line-enriched runner text Betfair actually renders) --
//     falls back to the bare `selection` when `selection_label` is absent,
//     which is EXACTLY today's behaviour for every caller that has not been
//     updated to send the new field yet.
//   - `expectedLineOverride` is the caller's already-verified numeric line,
//     used in place of deriving it from canonicalOutcomeKey(market_name,
//     selectionLabel).line when present.
//
// Money-risk gate (spec-B): a caller that opts INTO the split contract (a
// non-empty `selection_label` distinct from the plain single-field format)
// but omits `expected_line` for a line-bearing market family is a payload
// error, not a silent fallback -- silently re-deriving the line the OLD way
// here is exactly how a half-migrated Фаза3 caller could disable the
// all-blind line-evidence guard again without anyone noticing. Legacy
// callers that never send `selection_label` at all are entirely unaffected:
// they keep exactly today's derived-line behaviour, this gate never fires
// for them.
function resolveSelectionContract(body) {
  const marketName = String((body || {}).market_name || "");
  const marketType = String((body || {}).market_type || "").trim();
  const bareSelection = String((body || {}).selection || "").trim();
  const selectionLabelRaw = String((body || {}).selection_label || "").trim();
  const usesSplitContract = selectionLabelRaw.length > 0;
  const selectionLabel = selectionLabelRaw || bareSelection;

  let expectedLineOverride = null;
  const rawExpectedLine = (body || {}).expected_line;
  if (rawExpectedLine !== undefined && rawExpectedLine !== null && rawExpectedLine !== "") {
    const n = Number(rawExpectedLine);
    if (!Number.isFinite(n)) throw new Error("expected_line must be a finite number when provided");
    expectedLineOverride = n;
  }

  if (usesSplitContract && expectedLineOverride === null && isLineBearingMarketName(marketName, marketType)) {
    throw new Error(
      `expected_line is required when selection_label is provided for a line-bearing market (market_name: ${marketName})`
    );
  }

  return { selectionLabel, expectedLineOverride, marketType };
}

function validatePayload(body) {
  if (!body || typeof body.dry_run !== "boolean") throw new Error("dry_run boolean is mandatory");
  const url = new URL(String(body.event_url || ""));
  if (url.protocol !== "https:" || !["betfair.com", "www.betfair.com"].includes(url.hostname)) {
    throw new Error("Only HTTPS Betfair URLs are allowed");
  }
  if (!url.pathname.toLowerCase().includes("/betting/") || url.pathname.toLowerCase().includes("/exchange/")) {
    throw new Error("Only Betfair Sportsbook /betting/ event URLs are allowed");
  }
  for (const key of ["market_id", "selection_id", "market_name", "selection"]) {
    if (!String(body[key] || "").trim()) throw new Error(`${key} is required`);
  }
  const expectedOdds = Number(body.expected_odds);
  const stake = Number(body.stake);
  if (!Number.isFinite(expectedOdds) || expectedOdds <= 1) throw new Error("expected_odds must be > 1");
  if (!Number.isFinite(stake) || stake <= 0) throw new Error("stake must be positive");
  const { selectionLabel, expectedLineOverride, marketType } = resolveSelectionContract(body);
  return {
    ...body,
    event_url: url.toString(),
    expected_odds: expectedOdds,
    stake,
    selection_label: selectionLabel,
    expected_line: expectedLineOverride,
    market_type: marketType,
  };
}

// Story 2.2b: /resolve-market payload -- no market_id (that's what we're
// resolving) and no dry_run/stake (this call never touches the stake field
// or Place Bet). Reuses the same event_url shape guard as validatePayload.
function validateResolvePayload(body) {
  const url = new URL(String((body || {}).event_url || ""));
  if (url.protocol !== "https:" || !["betfair.com", "www.betfair.com"].includes(url.hostname)) {
    throw new Error("Only HTTPS Betfair URLs are allowed");
  }
  if (!url.pathname.toLowerCase().includes("/betting/") || url.pathname.toLowerCase().includes("/exchange/")) {
    throw new Error("Only Betfair Sportsbook /betting/ event URLs are allowed");
  }
  for (const key of ["selection_id", "market_name", "selection"]) {
    if (!String((body || {})[key] || "").trim()) throw new Error(`${key} is required`);
  }
  const expectedOdds = Number((body || {}).expected_odds);
  if (!Number.isFinite(expectedOdds) || expectedOdds <= 1) throw new Error("expected_odds must be > 1");
  const { selectionLabel, expectedLineOverride, marketType } = resolveSelectionContract(body);
  return {
    ...body,
    event_url: url.toString(),
    expected_odds: expectedOdds,
    selection_label: selectionLabel,
    expected_line: expectedLineOverride,
    market_type: marketType,
  };
}

async function acceptCookies(target) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "#accept-recommended-btn-handler",
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
  ];
  for (const selector of selectors) {
    const button = target.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true }).catch(() => {});
      await target.waitForTimeout(250);
    }
  }
  // OneTrust occasionally leaves its preference overlay mounted after the
  // consent action. It is non-betting UI and must not obscure market clicks.
  await target.evaluate(() => document.querySelector("#onetrust-consent-sdk")?.remove()).catch(() => {});
}

async function waitForCloudflare(target) {
  let cfRetries = 60;
  let clickCount = 0;
  const MAX_CF_CLICKS = 3;

  const moveMouseRealisticly = async (fromX, fromY, toX, toY, steps = 15) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const curveOffset = Math.sin(t * Math.PI) * 15;
      const x = fromX + (toX - fromX) * t + curveOffset * 0.5;
      const y = fromY + (toY - fromY) * t + curveOffset;
      await target.mouse.move(Math.round(x), Math.round(y)).catch(() => {});
      await target.waitForTimeout(10 + Math.random() * 15);
    }
  };

  let lastStatus = "unknown";
  while (cfRetries > 0) {
    const status = await target.evaluate(() => {
      const text = document.body ? document.body.innerText.toLowerCase() : "";
      const hasCfText = text.includes("security verification") || 
                       text.includes("waiting for www.betfair.com") ||
                       text.includes("just a moment") ||
                       text.includes("checking your browser") ||
                       text.includes("cloudflare");
      const hasCfElement = !!(document.querySelector("#challenge-running") || 
                             document.querySelector("#challenge-form") || 
                             document.querySelector("#cf-bubble"));
      if (hasCfText || hasCfElement) return "cloudflare";

      const hasBetfairElements = !!(
        document.querySelector("#scrollable-desktop-container") ||
        document.querySelector("#ssc-lis") ||
        document.querySelector("input[name='username']") ||
        document.querySelector(".accordion") ||
        document.querySelector(".market-accordion") ||
        document.querySelector(".market-title") ||
        document.querySelector(".market-header") ||
        document.querySelector(".responsive-layout") ||
        document.querySelector("#main-wrapper") ||
        document.querySelector(".bf-sportsbook-page")
      );
      return hasBetfairElements ? "ready" : "loading";
    }).catch(() => "error");

    lastStatus = status;
    if (status === "ready") {
      return;
    }

    if (status === "cloudflare" && clickCount < MAX_CF_CLICKS) {
      // Find the turnstile iframe
      const frames = target.context().pages().flatMap(p => p.frames());
      const cfFrame = frames.find(f => f.url().includes("challenges.cloudflare.com"));
      if (cfFrame) {
        await target.waitForTimeout(3000); // Let it render
        const iframeHandle = await cfFrame.frameElement().catch(() => null);
        if (iframeHandle) {
          const box = await iframeHandle.boundingBox().catch(() => null);
          if (box) {
            clickCount++;
            // Bring page to front just in case
            await target.bringToFront().catch(() => {});
            const startX = 50 + Math.random() * 50;
            const startY = 50 + Math.random() * 50;
            await target.mouse.move(startX, startY).catch(() => {});
            await target.waitForTimeout(300);
            
            const targetX = box.x + 30;
            const targetY = box.y + 32;
            
            console.log(`[CLOUDFLARE] Simulating mouse click on Turnstile (attempt ${clickCount}/${MAX_CF_CLICKS}) at (${targetX}, ${targetY})`);
            await moveMouseRealisticly(startX, startY, targetX, targetY);
            await target.waitForTimeout(150);
            
            await target.mouse.down().catch(() => {});
            await target.waitForTimeout(100 + Math.random() * 100);
            await target.mouse.up().catch(() => {});
            await target.waitForTimeout(2000);
          }
        }
      }
    }

    await target.waitForTimeout(1000);
    cfRetries--;
  }

  if (lastStatus === "cloudflare" || lastStatus === "loading") {
    throw new Error(`Cloudflare challenge unresolved after ${MAX_CF_CLICKS} click retries (status=${lastStatus})`);
  }
}

async function ensureLoggedIn(target, eventUrl) {
  const wanted = new URL(eventUrl);
  const current = new URL(target.url() || "about:blank", eventUrl);
  if (current.hostname !== wanted.hostname || current.pathname !== wanted.pathname) {
    await target.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await waitForCloudflare(target);
  await acceptCookies(target);
  const usernameInput = target.locator('input[name="username"]');
  if (!await usernameInput.isVisible().catch(() => false)) return true;

  const username = String(process.env.BETFAIR_USERNAME || "").trim();
  const password = String(process.env.BETFAIR_PASSWORD || "");
  if (!username || !password) throw new Error("Betfair Sportsbook account is not configured");
  await usernameInput.fill(username);
  await target.locator('input[name="password"]').fill(password);
  await target.locator("#ssc-lis").click();
  await target.waitForTimeout(2500);
  if (await usernameInput.isVisible().catch(() => false)) {
    const message = normalizeText(await target.locator("body").innerText().catch(() => ""));
    throw new Error(message.includes("incorrect") ? "Betfair login was rejected" : "Betfair login did not complete");
  }
  await target.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(target);
  await acceptCookies(target);
  return true;
}

// Story 2.2b fix-1 (P1): now VERIFIES the betslip is actually empty after
// attempting to clear it, instead of merely triggering "Remove All" and
// trusting it worked. readMatchingRunner's freshness-diff (below) depends on
// this baseline being genuinely empty -- if resetBetslip only *attempted* to
// clear but a stale runner survived, that runner could otherwise still
// satisfy a later "exactly one match" check for an unrelated click.
async function resetBetslip(target) {
  const hasState = await target.evaluate(() => Boolean(localStorage.getItem("sportsbookBettingState")));
  if (hasState) {
    const removeAll = target.getByRole("button", { name: /remove all/i }).first();
    if (await removeAll.isVisible().catch(() => false)) {
      await removeAll.click({ force: true });
      await target.waitForTimeout(350);
    } else {
      // Recovery for stale browser-local state when the UI cannot render it.
      await target.evaluate(() => localStorage.removeItem("sportsbookBettingState"));
      await target.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await acceptCookies(target);
    }
  }
  const raw = await target.evaluate(() => localStorage.getItem("sportsbookBettingState"));
  const state = raw ? JSON.parse(raw) : null;
  let remaining = state ? collectRunnerObjects(state) : [];
  if (remaining.length > 0) {
    // The visible Remove All control can acknowledge the click before the
    // persisted state is actually cleared. Recover deterministically and
    // verify again so sequential dry-runs never inherit a prior runner.
    await target.evaluate(() => localStorage.removeItem("sportsbookBettingState"));
    await target.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await acceptCookies(target);
    const retryRaw = await target.evaluate(() => localStorage.getItem("sportsbookBettingState"));
    const retryState = retryRaw ? JSON.parse(retryRaw) : null;
    remaining = retryState ? collectRunnerObjects(retryState) : [];
  }
  if (remaining.length > 0) {
    throw new Error(
      `Betslip did not clear before selection click: ${remaining.length} stale runner(s) remain`
    );
  }
}

// Reconcile regress1 P1-1 (money-critical, final cross-family audit fix):
// tags every currently-rendered market container with a stable per-node
// scan id (a DOM dataset attribute set ONCE, on first sight) and returns
// `{ scanId, text }` for each -- the stable identity `mergeLazyScanRounds`
// needs to tell "the same node seen again" apart from "a different node
// with identical text" (a genuine duplicate market).
async function scanCurrentMarketRows(target) {
  return target.locator(MARKET_CONTAINER_SELECTOR).evaluateAll((nodes) => nodes.map((node) => {
    if (!node.dataset.robinArbScanId) {
      node.dataset.robinArbScanId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    return {
      scanId: node.dataset.robinArbScanId,
      text: node.innerText || node.getAttribute("aria-label") || "",
    };
  }));
}

async function scrollLazyMarketList(target) {
  return target.evaluate(() => {
    const scroller = document.querySelector("#scrollable-desktop-container")
      || [...document.querySelectorAll("*")]
        .filter((node) => node.scrollHeight > node.clientHeight + 100)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      || document.scrollingElement || document.documentElement || document.body;
    const before = scroller.scrollTop;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(maxScroll, before + Math.max(600, scroller.clientHeight * 0.8));
    return scroller.scrollTop > before;
  });
}

async function clickExactSelection(target, marketName, selection, marketType) {
  await target.locator(MARKET_CONTAINER_SELECTOR).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  await target.waitForTimeout(3000);

  // Betfair lazily renders long all-markets lists. Scan each viewport while
  // retaining the atomic text/index read that avoids detached-locator races.
  await target.evaluate(() => {
    const scroller = document.querySelector("#scrollable-desktop-container")
      || [...document.querySelectorAll("*")]
        .filter((node) => node.scrollHeight > node.clientHeight + 100)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      || document.scrollingElement || document.documentElement || document.body;
    scroller.scrollTop = 0;
  });

  // Reconcile regress1 P1-1 (money-critical, final cross-family audit fix):
  // the OLD loop broke out of the scan the moment ANY single viewport
  // snapshot produced an exactly-one match -- it never proved that match
  // was unique across the WHOLE lazily-rendered list, so a duplicate market
  // (identical header, DIFFERENT market/DOM node) sitting in a not-yet-
  // rendered later viewport could silently go undetected. The scan now
  // always walks the list to its true end (scrollTop stops advancing)
  // BEFORE any match/ambiguity decision, accumulating every round via
  // resolveLazyScanMatch/mergeLazyScanRounds (identity-keyed, not
  // Set<headerText> -- see that module's doc comment for why a plain text
  // Set would wrongly collapse two real duplicate markets into one).
  // Reconcile regress2 P1 (money-critical, both final-audit reviewers
  // CONFIRMED): the 64-round cap had no "did the scan actually reach the
  // true end of the lazily-rendered list" assertion -- if scrollLazyMarketList
  // was STILL reporting `moved=true` on the 64th round (a very long list,
  // not yet exhausted), the loop simply stopped because the `for` condition
  // ran out, and everything below silently matched against a PARTIAL scan as
  // if it were the complete, page-wide answer. That defeats the whole point
  // of the exhaustive-scan fix (see mergeLazyScanRounds's doc comment): a
  // duplicate market sitting in the unscanned tail could go undetected.
  // Fail closed instead -- only `!moved` (scrollTop genuinely stopped
  // advancing, i.e. the real end of the list) counts as a complete scan;
  // hitting the round cap while still moving is now a hard error, never a
  // silent partial match.
  const rounds = [];
  let reachedEnd = false;
  for (let scan = 0; scan < 64; scan += 1) {
    rounds.push(await scanCurrentMarketRows(target));
    const moved = await scrollLazyMarketList(target);
    if (!moved) {
      reachedEnd = true;
      break;
    }
    await target.waitForTimeout(250);
  }
  assertScanReachedEnd(reachedEnd, marketName);

  const matchResult = resolveLazyScanMatch(matchMarketHeader, marketName, rounds, { selection, marketType });
  const { scanIds, texts: headerTexts } = matchResult;

  // Require EXACTLY ONE market container matching the wanted market name,
  // proven across the ENTIRE lazily-rendered list, not just one viewport.
  if (matchResult.ambiguous) {
    const ambiguousHeaders = (matchResult.matchedIndices || []).map((i) => headerTexts[i]);
    console.error(`DEBUG: Ambiguous market headers on page: ${JSON.stringify(ambiguousHeaders)}`);
    throw new Error(
      `Ambiguous market: ${ambiguousHeaders.length} containers match "${marketName}" -- refusing to guess`
    );
  }
  if (matchResult.index === null) {
    const allHeaders = [...new Set(headerTexts.map((text) => (text || "").trim()).filter(Boolean))];
    console.error(`DEBUG: Available headers on page: ${JSON.stringify(allHeaders)}`);
    throw new Error(`Market not found: ${marketName}`);
  }

  const winningScanId = scanIds[matchResult.index];
  const exactTitleText = headerTexts[matchResult.index];
  // Reconcile regress2 P0 (money-critical, final cross-family audit
  // CONFIRMED): winningSelector must qualify EVERY comma-separated term of
  // MARKET_CONTAINER_SELECTOR with the scan-id attribute (buildScanIdSelector),
  // NOT naively append the attribute to the raw comma-list string -- the
  // naive form only bound the attribute to the LAST term
  // (`.accordion-trigger[data-...]`), leaving the other 9 terms
  // unqualified, so `.locator(winningSelector).first()` matched the FIRST
  // h2/h3/.accordion/etc. anywhere on the page instead of the actual
  // scan-proven winner. See buildScanIdSelector's doc comment for the full
  // CSS-semantics explanation.
  const winningSelector = buildScanIdSelector(MARKET_CONTAINER_SELECTOR, winningScanId);

  // The winning node was identified during the exhaustive forward scan and
  // may no longer be mounted (scrolled far past, if the list ever
  // virtualizes-away distant nodes) -- scroll back to the top and step
  // forward again, re-checking for the tagged node at each step, exactly
  // the same lazy-scroll mechanism used above. Fail closed (never fall back
  // to a different node) if it cannot be re-located.
  let exactTitle = target.locator(winningSelector).first();
  if (!(await exactTitle.count().catch(() => 0))) {
    await target.evaluate(() => {
      const scroller = document.querySelector("#scrollable-desktop-container")
        || [...document.querySelectorAll("*")]
          .filter((node) => node.scrollHeight > node.clientHeight + 100)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
        || document.scrollingElement || document.documentElement || document.body;
      scroller.scrollTop = 0;
    });
    for (let scan = 0; scan < 64; scan += 1) {
      if (await target.locator(winningSelector).count().catch(() => 0)) break;
      const moved = await scrollLazyMarketList(target);
      if (!moved) break;
      await target.waitForTimeout(200);
    }
    exactTitle = target.locator(winningSelector).first();
  }
  if (!(await exactTitle.count().catch(() => 0))) {
    throw new Error(
      `Market matched during scan ("${exactTitleText}") could not be re-located for click: ${marketName}`
    );
  }
  // Defense-in-depth (regress2 P0): confirm the node the selector actually
  // resolved to carries the SAME scan id the exhaustive scan proved was the
  // unique winner, not merely "the first node winningSelector happened to
  // match" -- catches any future regression to the comma-list CSS bug
  // buildScanIdSelector fixes above, rather than trusting the selector was
  // built correctly on faith.
  const resolvedScanId = await exactTitle.evaluate((node) => node.dataset.robinArbScanId).catch(() => null);
  if (resolvedScanId !== winningScanId) {
    throw new Error(
      `Market re-location resolved to the wrong DOM node (scan id "${resolvedScanId}" != winner "${winningScanId}") for click: ${marketName}`
    );
  }
  await acceptCookies(target);
  // Story 2.2b fix-2 (P1): stop climbing as soon as the ancestor spans more
  // than just this one market's container -- crossing into a shared
  // ancestor that also contains ANOTHER market's container is exactly how a
  // wrong market's selection button could satisfy the "exactly one matching
  // button" check below even though it belongs to a different market than
  // the one just clicked. Bounding the climb this way scopes the search to
  // the specific market container instead of blindly walking up to 9 DOM
  // ancestors through other markets.
  //
  // Story 2.2b fix-3 (P1): the climb-boundary selector must be the EXACT
  // SAME selector used to enumerate market candidates above
  // (MARKET_CONTAINER_SELECTOR) -- a boundary selector missing a class the
  // candidate scan treats as a market container (.accordion,
  // .market-accordion) let the climb walk straight past a COLLAPSED
  // target's own container into a shared ancestor and pick up a
  // neighboring EXPANDED market's uniquely-named button. climbToMarketContainer
  // is the actual production algorithm (imported, not reimplemented here) so
  // it is exercised for real both here and in its own node:test suite.
  const findSelection = () => exactTitle.evaluateHandle(climbToMarketContainer, {
    wanted: selection,
    headerSelector: MARKET_CONTAINER_SELECTOR,
  });
  let handle = await findSelection();
  if (!handle.asElement()) {
    await handle.dispose();
    await exactTitle.scrollIntoViewIfNeeded();
    await exactTitle.click();
    await target.waitForTimeout(500);
    handle = await findSelection();
  }
  const element = handle.asElement();
  if (!element) throw new Error(`Selection not found unambiguously in ${marketName}: ${selection}`);

  // Story 2.4: `element` is the NAME/line button climbToMarketContainer just
  // resolved via raw-text matching -- on Handicap/Totals markets this is a
  // SEPARATE, non-interactive-for-betslip button from the odds button that
  // actually adds the runner to the betslip (confirmed live 2026-07-15:
  // clicking the name left sportsbookBettingState empty, STATE_LEN 0).
  //
  // Defense-in-depth (AC-2): re-verify the match with a canonical outcome
  // key (line + side, not just raw startsWith text) before clicking
  // anything -- catches the case where climbToMarketContainer's looser
  // startsWith fallback matched a button that LOOKS like a prefix of the
  // wanted selection but is actually a different line/side.
  const nameText = await element.innerText().catch(() => "");
  if (isOddsButtonText(nameText)) {
    throw new Error(`Selection not found: matched button "${nameText}" is odds-shaped, expected a name/line button in ${marketName}`);
  }
  const wantedKey = canonicalOutcomeKey(marketName, selection);
  // Story 2.4 fix-round-1 (P2): pass `selection` as the wanted-context 3rd
  // arg so a bare trailing number in `nameText` is only treated as embedded
  // odds when it is strictly ADDITIONAL beyond the wanted text -- not
  // stripped from participant names that legitimately end in a digit
  // (e.g. "Team 1"), see betfair_sportsbook_selection_match.cjs.
  const matchedKey = canonicalOutcomeKey(marketName, nameText, selection);
  if (!outcomeKeysEqual(wantedKey, matchedKey)) {
    throw new Error(
      `Ambiguous selection: matched button "${nameText}" does not canonically match wanted "${selection}" in ${marketName}`
    );
  }

  // Moneyline/Match Odds: name+odds are the SAME button -> click it (Story
  // 2.4 AC-6, no regression). Handicap/Totals: click the SEPARATE odds
  // button paired with the name button just resolved (Story 2.4 AC-1/AC-4).
  let clickTarget = element;
  if (!matchedKey.embeddedOdds) {
    const resultHandle = await element.evaluateHandle(findAdjacentOddsButton, { maxDepth: 5 });
    const buttonHandle = await resultHandle.getProperty("button");
    const ambiguous = await (await resultHandle.getProperty("ambiguous")).jsonValue();
    clickTarget = buttonHandle.asElement();
    if (!clickTarget) {
      const label = ambiguous ? "Ambiguous selection" : "Selection not found";
      const reason = ambiguous ? "multiple odds-shaped buttons nearby" : "no odds button found near the name button";
      throw new Error(`${label}: odds button for "${nameText}" in ${marketName} (${reason})`);
    }
  }
  await clickTarget.scrollIntoViewIfNeeded();
  await clickTarget.click();
  await target.waitForTimeout(700);
  // Returned so the caller (readMatchingRunner) can cross-check betslip
  // identity against the market header actually clicked, not just
  // selectionId (Story 2.2b fix-1, P1).
  //
  // Reconcile Фаза2 task 3 ("actual-evidence return", ported from MINE):
  // also report whether the ACTUAL matched header text and the ACTUAL
  // clicked name/line button each independently commit to an explicit
  // numeric line. The Фаза1 matcher's lineCheckPasses() lets an unlined
  // header match a lined forted source on the promise that the line gets
  // re-verified downstream at the runner level -- readMatchingRunner needs
  // these two signals (plus runner.handicap) to know whether that promise
  // was actually kept, or whether the line is about to go completely
  // unverified. `headerHasExplicitLine` uses parseMarketIdentity on the
  // ACTUAL clicked header text (exactTitleText), NOT the source market_name
  // -- it must reflect what the page really rendered. `buttonHasExplicitLine`
  // reuses matchedKey.lineFromText, already computed above from the ACTUAL
  // clicked name/line button's own text.
  const headerHasExplicitLine = parseMarketIdentity(exactTitleText).numericLine !== null;
  return {
    clickedMarketText: exactTitleText,
    headerHasExplicitLine,
    buttonHasExplicitLine: matchedKey.lineFromText,
  };
}

function decimalOdds(runner) {
  const candidates = [runner.odds, runner.decimalOdds, runner.price, runner.currentPrice];
  for (const value of candidates) {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === "object") {
      for (const key of ["decimal", "decimalOdds", "value"]) {
        if (Number.isFinite(Number(value[key]))) return Number(value[key]);
      }
    }
  }
  return null;
}

// Story 2.2b fix-1 (P1): identity is now checked on TWO independent signals,
// not selectionId alone:
//  1. freshness -- `baselineRunners` is the (verified-empty, see
//     resetBetslip) betslip state captured before the click, so any runner
//     present afterward was necessarily produced BY this click, not a
//     leftover from an earlier action;
//  2. market_name plausibility -- `clickedMarketText` is the exact header
//     text clickExactSelection matched on, cross-checked (best-effort, see
//     betfair_sportsbook_market_identity.cjs) against any market-name-like
//     ancestor field the betslip state happens to carry for that runner.
// Both a >1 ambiguous match and a market-name mismatch fail closed.
//
// Reconcile Фаза2 task 3 (ported from MINE): `headerHasExplicitLine`/
// `buttonHasExplicitLine` are the two signals clickExactSelection captured
// about the ACTUAL clicked header/button text (see its doc comment) --
// passed through so this function can tell whether the deferred-line
// promise ("the line gets independently re-verified downstream") was
// actually kept once the runner itself is known, or whether the line is
// about to be trusted on nothing at all.
async function readMatchingRunner(
  target,
  payload,
  baselineRunners,
  clickedMarketText,
  expectedLine,
  headerHasExplicitLine,
  buttonHasExplicitLine
) {
  const baseline = baselineRunners || [];
  for (let attempt = 0; attempt < 15; attempt++) {
    const raw = await target.evaluate(() => localStorage.getItem("sportsbookBettingState"));
    if (raw) {
      const state = JSON.parse(raw);
      const allRunners = collectRunnerObjects(state);
      const matches = selectFreshMatchingRunners(baseline, allRunners, payload.selection_id);
      if (matches.length === 1) {
        const runner = matches[0];
        const contexts = collectRunnerContexts(state);
        const context = contexts.find((c) => c.runner === runner);
        const hint = context ? context.marketNameHint : null;
        if (!marketIdentityPlausible(clickedMarketText, hint)) {
          throw new Error(
            `Betslip market identity mismatch: clicked "${clickedMarketText}" but resolved runner's market hint is "${hint}"`
          );
        }
        // Story 2.4 (AC-5): confirmed-schema hardening -- the runner's own
        // `handicap` field (when it IS a real number) must agree with the
        // expected handicap/total line derived from the clicked selection.
        if (!handicapPlausible(expectedLine, runner.handicap)) {
          throw new Error(
            `Betslip market identity mismatch: expected line ${expectedLine}, runner.handicap is ${JSON.stringify(runner.handicap)}`
          );
        }
        // Reconcile Фаза2 task 3 (all-blind rejection, ported from MINE,
        // defense-in-depth): handicapPlausible above intentionally fails
        // OPEN (true) whenever runner.handicap is unusable -- null/undefined
        // (the confirmed-live shape for a genuine handicap runner, Story
        // 2.4) or any other non-finite/garbage value. That fail-open is
        // safe ONLY because the line is normally also confirmed by the
        // header text or the button text. If NEITHER the matched header nor
        // the matched button carried an explicit line either (the
        // deferred-unlined-header path) AND runner.handicap is unusable,
        // nothing anywhere ever verified the expected line -- refuse to bet
        // on faith instead of silently trusting whichever runner froze
        // fresh.
        if (
          !isUsableNumeric(runner.handicap)
          && lineVerificationRequired({ expectedLine, headerHasExplicitLine, buttonHasExplicitLine })
        ) {
          throw new Error(
            `Betslip market identity mismatch: expected line ${expectedLine} could not be independently verified ` +
            `(unlined header, line-less button, and runner.handicap is ${JSON.stringify(runner.handicap)}) -- refusing to bet blind`
          );
        }
        return runner;
      }
      if (matches.length > 1) {
        console.error("DEBUG Betslip identity mismatch - ambiguous fresh runners:", JSON.stringify(matches, null, 2));
        throw new Error(
          `Betslip identity mismatch: ${matches.length} fresh runners match selection_id ${payload.selection_id} after click -- refusing to guess`
        );
      }
    }
    await target.waitForTimeout(200);
  }

  const raw = await target.evaluate(() => localStorage.getItem("sportsbookBettingState"));
  const state = raw ? JSON.parse(raw) : null;
  const allRunners = state ? collectRunnerObjects(state) : [];
  console.error("DEBUG Betslip identity mismatch - all collected runners:", JSON.stringify(allRunners, null, 2));
  console.error("DEBUG Betslip identity mismatch - expected market_id:", payload.market_id, "selection_id:", payload.selection_id);

  // Story 2.4 (AC-3): a betslip that is genuinely EMPTY after the click
  // (not merely missing the wanted selection among other runners) is the
  // exact signature of the bug this story fixes -- the click hit a
  // non-interactive name/line button instead of the odds button. Report it
  // explicitly instead of the generic "found 0" message so this failure
  // mode is never silent/ambiguous with an unrelated "wrong runner" case.
  if (!raw || allRunners.length === 0) {
    throw new Error(
      `Betslip is empty after selection click -- the click likely hit a non-interactive name/line button instead of the odds button (expected selection_id ${payload.selection_id})`
    );
  }
  const matchesCount = selectFreshMatchingRunners(baseline, allRunners, payload.selection_id).length;

  throw new Error(`Betslip identity mismatch: expected selection_id ${payload.selection_id}, found ${matchesCount}`);
}

// Scopes REAL PLACE lookups (button, Accept notice, result text) to the
// betting coupon rather than the whole document — the page also has an
// unrelated cookie-consent "Accept" button outside the betslip. Real
// placement is fail-closed: with no reliable scope, this throws instead of
// falling back to `body` (a document-wide Accept/Place-Bet search risks a
// blind mis-click of unrelated UI while money is on the line).
async function getBetslipScope(target) {
  const byMarker = target
    .locator('[class*="betslip" i], [class*="bet-slip" i], [id*="betslip" i], [data-test*="betslip" i]')
    .first();
  if (await byMarker.count().catch(() => 0)) return byMarker;

  // No explicit betslip marker class — derive a bounded scope from the
  // stake input's nearest ancestor that also contains a button, instead of
  // trusting arbitrary markup guesses or defaulting to the whole document.
  const stakeInput = target.locator('input[aria-label="Stake"], input[placeholder="Stake"]').first();
  if (await stakeInput.isVisible().catch(() => false)) {
    const fromStake = stakeInput.locator("xpath=ancestor::*[.//button][1]");
    if (await fromStake.count().catch(() => 0)) return fromStake.first();
  }

  throw new Error(
    "Betfair Sportsbook betslip container was not found — refusing real placement without a reliable scope"
  );
}

// "Maximum payout limits may be applied" banner with an Accept link/button
// directly above the Place Bet button. Silently a no-op when absent.
async function acceptMaxPayoutNotice(target, scope) {
  const notice = scope.getByText(/maximum payout limits may be applied/i).first();
  if (!await notice.isVisible().catch(() => false)) return false;
  const accept = scope
    .getByRole("link", { name: /^accept$/i })
    .or(scope.getByRole("button", { name: /^accept$/i }))
    .first();
  if (!await accept.isVisible().catch(() => false)) return false;
  await accept.click({ force: true }).catch(() => {});
  await target.waitForTimeout(400);
  return true;
}

const RESULT_NODE_SELECTOR =
  '.betslip-receipt, [class*="receipt" i], [role="alert"], [class*="betslip-message" i], [class*="error" i], [data-test*="receipt" i], [data-test*="error" i]';

// Reads only VISIBLE result-node texts within scope. allInnerTexts() on the
// bare locator (the old implementation) also picks up hidden/stale nodes —
// a leftover hidden "Receipt" from a previous action could otherwise read
// as a false BET_PLACED, and a stale hidden error could turn a passing bet
// into a clean reject.
async function collectVisibleResultTexts(scope) {
  const elements = await scope.locator(RESULT_NODE_SELECTOR).all().catch(() => []);
  const texts = [];
  for (const element of elements) {
    if (!await element.isVisible().catch(() => false)) continue;
    const text = await element.innerText().catch(() => "");
    if (text && text.trim()) texts.push(text);
  }
  return texts;
}

// Polls the betslip scope for a receipt/error element for up to `timeoutMs`
// (default: unchanged 5s). Only considers text that is both visible AND new
// relative to `baselineTexts` (captured immediately before the click) — a
// visible-but-unchanged node predates the click and must not be read as its
// outcome. Returns "success" | "error" | "indeterminate" — indeterminate on
// timeout must NOT be treated as BET_PLACED nor as a clean failure, since
// the click may have gone through with the confirmation UI simply failing
// to render/match.
async function pollPlacementResult(target, scope, baselineTexts, timeoutMs = 5000) {
  const baseline = new Set(baselineTexts);
  const deadline = Date.now() + timeoutMs;
  do {
    const texts = await collectVisibleResultTexts(scope);
    const freshTexts = texts.filter((text) => !baseline.has(text));
    for (const text of freshTexts) {
      if (isReceiptText(text)) return { outcome: "success", text };
    }
    for (const text of freshTexts) {
      if (isBetslipErrorText(text)) return { outcome: "error", text };
    }
    await target.waitForTimeout(200);
  } while (Date.now() < deadline);
  return { outcome: "indeterminate", text: "" };
}

async function prepareBetslip(body) {
  const startedAt = Date.now();
  const payload = validatePayload(body);
  const target = await ensureBrowser();

  // Keep the network route-guard engaged (dry-run) through preparation
  // regardless of the request's dry_run flag. For dry_run=false it is only
  // disarmed for the narrow click+result-wait window inside REAL PLACE
  // below (nested try/finally), never for navigation/login/selection/stake.
  activeRequestDryRun = true;

  try {
    await ensureLoggedIn(target, payload.event_url);
    // resetBetslip throws unless it can verify the betslip is genuinely
    // empty afterward -- readMatchingRunner's freshness-diff can therefore
    // safely start from an empty baseline (Story 2.2b fix-1, P1).
    await resetBetslip(target);
    // Reconcile Фаза2 task 5: clicking/matching use `selection_label` (the
    // line-enriched wanted text), which falls back to the bare `selection`
    // when the caller has not sent a separate label -- exactly today's
    // behaviour for every not-yet-migrated caller.
    const { clickedMarketText, headerHasExplicitLine, buttonHasExplicitLine } =
      await clickExactSelection(target, payload.market_name, payload.selection_label, payload.market_type);
    const derivedKey = canonicalOutcomeKey(payload.market_name, payload.selection_label);
    const expectedLine = payload.expected_line !== null && payload.expected_line !== undefined
      ? payload.expected_line
      : derivedKey.line;

    const runner = await readMatchingRunner(
      target,
      payload,
      [],
      clickedMarketText,
      expectedLine,
      headerHasExplicitLine,
      buttonHasExplicitLine
    );
    const actualOdds = decimalOdds(runner);
    if (!oddsEquivalent(actualOdds, payload.expected_odds)) {
      throw new Error(`Sportsbook price changed: expected ${payload.expected_odds}, got ${actualOdds}`);
    }

    const stakeInput = target.locator('input[aria-label="Stake"], input[placeholder="Stake"]').first();
    if (!await stakeInput.isVisible().catch(() => false)) throw new Error("Sportsbook stake field was not found");
    await stakeInput.fill(payload.stake.toFixed(2));
    await target.waitForTimeout(600);
    const inputStake = Number(await stakeInput.inputValue());
    if (!Number.isFinite(inputStake) || Math.abs(inputStake - payload.stake) > 0.001) {
      throw new Error(`Stake field mismatch: expected ${payload.stake}, got ${inputStake}`);
    }

    let screenshot;
    let status = "BETSLIP_READY_DRY_RUN";
    let submitBlocked = true;

    if (payload.dry_run) {
      screenshot = path.join(SCREENSHOT_DIR, `${safeId(payload.arb_id)}-${Date.now()}.png`);
      await target.screenshot({ path: screenshot, fullPage: false });
    } else {
      // REAL PLACE
      const scope = await getBetslipScope(target);
      await acceptMaxPayoutNotice(target, scope);

      // Locator is lazy (re-resolved on every action), so it naturally picks
      // up the post-Accept re-render without a second explicit search.
      const placeBetBtn = scope.getByRole("button", { name: placeBetButtonRegex }).first();
      if (!await placeBetBtn.isVisible().catch(() => false)) {
        const buttonElements = await scope.locator("button").all().catch(() => []);
        const visibleButtons = [];
        for (const button of buttonElements) {
          if (!await button.isVisible().catch(() => false)) continue;
          visibleButtons.push(await button.innerText().catch(() => ""));
        }
        throw new Error(
          `Place Bet button is not visible on Betfair Sportsbook. Visible buttons: ${JSON.stringify(visibleButtons)}`
        );
      }
      if (await placeBetBtn.isDisabled().catch(() => false)) {
        throw new Error("Place Bet button is disabled on Betfair Sportsbook");
      }

      // Snapshot visible result-node texts BEFORE the click so the poll can
      // tell a genuinely new receipt/error apart from a stale leftover node.
      const baselineResultTexts = await collectVisibleResultTexts(scope);

      // Story 2.2b fix-2 (P1): the outcome classification (success / clean
      // error / indeterminate) and the post-click screenshot are delegated
      // to runPlaceBetClick (betfair_sportsbook_place_click.cjs) so a
      // screenshot failure can never mask or override an outcome already
      // determined by the click+poll step -- see that module's doc comment
      // for the exact bug this replaces. Disarm the placement-POST
      // route-guard for the click+poll+screenshot window; preparation above
      // (navigation, login, selection, stake) always ran with the guard
      // engaged, and the outer finally below still re-arms it as a safe
      // default regardless of how this block exits.
      activeRequestDryRun = false;
      let placeOutcome;
      try {
        placeOutcome = await runPlaceBetClick({
          click: async () => {
            await placeBetBtn.click();
          },
          poll: async () => pollPlacementResult(target, scope, baselineResultTexts, 5000),
          screenshot: async () => {
            const screenshotPath = path.join(SCREENSHOT_DIR, `${safeId(payload.arb_id)}-placed-${Date.now()}.png`);
            await target.screenshot({ path: screenshotPath, fullPage: false });
            return screenshotPath;
          },
        });
      } finally {
        activeRequestDryRun = true;
      }

      screenshot = placeOutcome.screenshot;
      status = "BET_PLACED";
      submitBlocked = false;
    }

    const result = {
      ok: true,
      status,
      provider: "betfair-sportsbook",
      dry_run: payload.dry_run,
      event_url: payload.event_url,
      market_id: String(payload.market_id),
      selection_id: String(payload.selection_id),
      selection: payload.selection,
      market_name: payload.market_name,
      odds: actualOdds,
      stake: inputStake,
      screenshot,
      submit_blocked: submitBlocked,
      elapsed_ms: Date.now() - startedAt,
    };
    lastResult = result;
    lastError = "";
    return result;
  } catch (error) {
    const errorScreenshot = path.join(SCREENSHOT_DIR, `${safeId(payload.arb_id)}-error-${Date.now()}.png`);
    if (target && !target.isClosed()) {
      await target.screenshot({ path: errorScreenshot, fullPage: false }).catch(() => {});
    }
    throw error;
  } finally {
    // Safe default: block placement POSTs again once this request is done,
    // so an idle browser never leaves the network route-guard disarmed.
    activeRequestDryRun = true;
  }
}

// Story 2.2b: resolves the BETFAIR market_id/selection_id for a selection
// that the caller only knows by a foreign-namespace (Paddy) market_id --
// implyBets rejects a Paddy market_id with MARKET_NOT_FOUND. Reuses the same
// login/reset/click/read pipeline as prepareBetslip's REAL PLACE path, but
// stops before the stake field and never clicks Place Bet: clickExactSelection
// already fails closed if market_name+selection cannot be matched unambiguously
// on the page, and readMatchingRunner fails closed if the resulting
// localStorage state has anything other than exactly one runner for the given
// selection_id (advisory: a bare selection_id can otherwise match >1 market).
async function resolveMarketViaDom(body) {
  const startedAt = Date.now();
  const payload = validateResolvePayload(body);
  const target = await ensureBrowser();

  // Resolution never places -- the network route-guard stays engaged for the
  // whole call, unlike prepareBetslip's narrow REAL PLACE disarm window.
  activeRequestDryRun = true;

  try {
    await ensureLoggedIn(target, payload.event_url);
    await resetBetslip(target);
    const { clickedMarketText, headerHasExplicitLine, buttonHasExplicitLine } =
      await clickExactSelection(target, payload.market_name, payload.selection_label, payload.market_type);
    const derivedKey = canonicalOutcomeKey(payload.market_name, payload.selection_label);
    const expectedLine = payload.expected_line !== null && payload.expected_line !== undefined
      ? payload.expected_line
      : derivedKey.line;

    const runner = await readMatchingRunner(
      target,
      { selection_id: payload.selection_id, market_id: "(resolving)" },
      [],
      clickedMarketText,
      expectedLine,
      headerHasExplicitLine,
      buttonHasExplicitLine
    );
    const actualOdds = decimalOdds(runner);
    if (!oddsEquivalent(actualOdds, payload.expected_odds)) {
      throw new Error(`Sportsbook price changed: expected ${payload.expected_odds}, got ${actualOdds}`);
    }
    const betfairMarketId = runner.marketId != null ? String(runner.marketId) : "";
    const betfairSelectionId = runner.selectionId != null ? String(runner.selectionId) : "";
    if (!betfairMarketId || !betfairSelectionId) {
      throw new Error("Resolved runner is missing betfair marketId/selectionId");
    }

    return {
      ok: true,
      status: "MARKET_RESOLVED",
      provider: "betfair-sportsbook",
      event_url: payload.event_url,
      betfair_market_id: betfairMarketId,
      betfair_selection_id: betfairSelectionId,
      market_name: payload.market_name,
      selection: payload.selection,
      odds: actualOdds,
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    activeRequestDryRun = true;
  }
}

async function resolveEventUrlViaSearch(target, requestedUrl) {
  const participants = eventParticipantsFromUrl(requestedUrl);
  if (!participants) throw new Error("Betfair event URL cannot be mapped to search participants");
  const queryTokens = participants.home.length >= 2
    ? participants.home
    : [...participants.home, ...participants.away];
  const searchPayload = await requestEventSearch(target, queryTokens.join(" "));
  const results = searchPayload?.data?.Search?.results || [];
  const scored = results
    .filter((result) => result && result.__typename === "EventView" && result.url)
    .map((result) => ({
      result,
      score: eventSearchScore(requestedUrl, `https://www.betfair.com/betting/${result.url}`),
    }))
    .filter((item) => item.score >= 1.5)
    .sort((left, right) => right.score - left.score);
  if (!scored.length || (scored[1] && Math.abs(scored[0].score - scored[1].score) < 0.001)) {
    throw new Error(`Betfair event search did not resolve uniquely for ${queryTokens.join(" ")}`);
  }
  return `https://www.betfair.com/betting/${String(scored[0].result.url).replace(/^\/+/, "")}?tab=all-markets`;
}

async function resolveMarket(body) {
  const startedAt = Date.now();
  const payload = validateResolvePayload(body);
  const target = await ensureBrowser();
  activeRequestDryRun = true;

  try {
    await ensureLoggedIn(target, payload.event_url);
    let effectiveEventUrl = target.url();
    let eventMappingMode = "event_url";
    const requestedEventId = payload.event_url.match(/\/e-(\d+)/)?.[1] || "";
    const loadedEventId = effectiveEventUrl.match(/\/e-(\d+)/)?.[1] || "";
    if (!loadedEventId || (requestedEventId && loadedEventId !== requestedEventId)) {
      effectiveEventUrl = await resolveEventUrlViaSearch(target, payload.event_url);
      eventMappingMode = "search_requests";
      await ensureLoggedIn(target, effectiveEventUrl);
    }
    const catalogReady = await target.waitForFunction(
      () => /(?:expandableMarket|card:market):\d+\.\d+/.test(document.documentElement.outerHTML),
      null,
      { timeout: 4000 }
    ).then(() => true).catch(() => false);
    if (!catalogReady && eventMappingMode !== "search_requests") {
      effectiveEventUrl = await resolveEventUrlViaSearch(target, payload.event_url);
      eventMappingMode = "search_requests";
      await ensureLoggedIn(target, effectiveEventUrl);
    }
    await target.waitForFunction(
      () => /(?:expandableMarket|card:market):\d+\.\d+/.test(document.documentElement.outerHTML),
      null,
      { timeout: 8000 }
    );
    const eventMatch = effectiveEventUrl.match(/\/e-(\d+)/);
    if (!eventMatch) throw new Error("Betfair event id is missing from event_url");
    const marketIds = await target.evaluate(() => [...new Set(
      [...document.documentElement.outerHTML.matchAll(/(?:expandableMarket|card:market):(\d+\.\d+)/g)]
        .map((match) => match[1])
    )]);
    if (!marketIds.length) throw new Error("Betfair request catalog returned no market ids");

    const batches = [];
    for (let index = 0; index < marketIds.length; index += 4) {
      batches.push(marketIds.slice(index, index + 4));
    }
    const batchResults = await Promise.all(
      batches.map((ids) => requestCatalogCards(target, eventMatch[1], ids, "expandableMarket"))
    );
    const expandableCards = batchResults.flatMap((result) => result.data && result.data.Cards || []);
    // Reconcile Фаза2 task 1 (spec-B "Как встроить matcher"): apply the
    // Фаза1 structural matcher (matchMarketHeader) to every card.title,
    // dedup by the STABLE card.urn/marketId, accept exactly one distinct
    // URN -- 0 or >1 rejects. Matching/clicking use `selection_label` (falls
    // back to bare `selection` for callers not yet migrated, Фаза2 task 5).
    // Catalog ambiguity is NEVER rescued by a DOM fallback -- this path has
    // none.
    const cardMatch = resolveCatalogMarketCard(
      payload.market_name,
      payload.selection_label,
      expandableCards,
      payload.market_type
    );
    if (!cardMatch.ok) {
      if (cardMatch.reason === "ambiguous") {
        throw new MarketSemanticRejectError(
          `Ambiguous Betfair request catalog market: ${JSON.stringify(cardMatch.matchedTitles)}`
        );
      }
      if (cardMatch.reason === "no_market_id") {
        throw new MarketSemanticRejectError("Matched Betfair catalog card has no market id");
      }
      // "not_found" -- the strict matcher looked and found nothing at all,
      // as opposed to finding and REJECTING an ambiguous/unsafe candidate.
      //
      // Reconcile regress2 P1-#5 (money-critical, both final-audit reviewers
      // CONFIRMED): this used to be left as an ordinary (infra-treated)
      // Error on the theory that a safe DOM fallback for a genuinely absent
      // catalog entry carries none of the "DOM re-resolves a definitively-
      // rejected match differently" risk the other semantic cases above do.
      // That theory doesn't hold: an ordinary Error here maps to
      // "MARKET_RESOLVE_FAILED" (see the /resolve-market handler below),
      // which server.py/betfair_sportsbook_place_api.py treat as a safe,
      // retry-elsewhere infra failure and fall back to the legacy DOM
      // /basket clickExactSelection path -- the SAME path the P0 fix above
      // hardens, but "not found in the catalog" is itself evidence the
      // market/selection may not safely resolve there either. Routed via the
      // shared, unit-tested isCatalogResolutionFailureTerminal classifier
      // (betfair_sportsbook_catalog_resolve.cjs) rather than an ad hoc throw,
      // so the terminal/retryable decision has one source of truth: never
      // spend the permissive DOM fallback on a catalog miss.
      const NotFoundError = isCatalogResolutionFailureTerminal("not_found") ? MarketSemanticRejectError : Error;
      // Include a small, public-data-only sample from the same market family
      // in the admin diagnostic. This keeps future bookmaker title drift
      // observable without exposing cookies, account data, or runner prices.
      const familyPattern = /handicap/i.test(payload.market_name)
        ? /handicap/i
        : /total|over\/under/i.test(payload.market_name)
          ? /total|over\/under/i
          : /match odds|winner/i;
      const relatedTitles = [...new Set(
        expandableCards
          .map((card) => String((card && card.title) || "").trim())
          .filter((title) => title && familyPattern.test(title))
      )].slice(0, 16);
      const hint = relatedTitles.length ? `; related catalog titles: ${JSON.stringify(relatedTitles)}` : "";
      throw new NotFoundError(`Market not found in Betfair request catalog: ${payload.market_name}${hint}`);
    }
    const betfairMarketId = cardMatch.betfairMarketId;
    const matchedTitle = String(expandableCards[cardMatch.index]?.title || "");

    const marketResult = await requestCatalogCards(target, eventMatch[1], [betfairMarketId], "market");
    const marketCards = marketResult.data && marketResult.data.Cards || [];
    // Reconcile regress2 P1-#5 (money-critical, both final-audit reviewers
    // CONFIRMED): a per-market GraphQL response that returns anything other
    // than exactly one card for a betfairMarketId that was JUST uniquely
    // resolved above is itself a definitive rejection (0 cards: the market
    // vanished/is stale; >1 cards: the server can no longer disambiguate
    // which is the real one) -- not an infra hiccup safe to retry via the
    // permissive DOM fallback. Same MARKET_RESOLVE_FAILED->DOM-fallback risk
    // as the not_found case just above; routed through the same shared
    // classifier ("wrong_market_card_count").
    if (marketCards.length !== 1) {
      const CountError = isCatalogResolutionFailureTerminal("wrong_market_card_count")
        ? MarketSemanticRejectError : Error;
      throw new CountError(`Betfair market request returned ${marketCards.length} cards`);
    }
    // Task "Ownership" (spec-B item 3, hardened P2 final audit): cross-check
    // the SECOND (per-market) GraphQL response's own urn against the
    // requested betfairMarketId via the pure, unit-tested
    // verifyCatalogMarketOwnership helper -- see its doc comment for why an
    // absent urn is now fail-CLOSED rather than fail-open.
    const ownership = verifyCatalogMarketOwnership(marketCards[0]?.urn, betfairMarketId);
    if (!ownership.ok) {
      const detail = ownership.reason === "missing_urn"
        ? `Betfair market response has no urn to verify ownership against requested ${betfairMarketId}`
        : `Betfair market response urn ${ownership.returnedMarketId} does not match requested ${betfairMarketId}`;
      throw new MarketSemanticRejectError(detail);
    }
    const sportsbookMarket = marketCards[0]?.displayRunners?.sportsbook?.market;
    if (!sportsbookMarket) throw new Error("Betfair market request has no sportsbook market");

    // Task "Runner exactly-one" (spec-B item 4): selection_id + canonical-
    // name match ONLY -- no name-only fallback when selection_id doesn't
    // match (Paddy/Betfair share selection_id across DIFFERENT market_ids).
    // Exactly-one liveRunner (filter().length===1, never .find()).
    const runnerMatch = resolveCatalogRunner(
      payload.market_name,
      { selection: payload.selection_label, selection_id: payload.selection_id },
      sportsbookMarket
    );
    if (!runnerMatch.ok) {
      if (runnerMatch.reason === "not_active") {
        throw new MarketSemanticRejectError(`Betfair request-catalog runner is not active: ${payload.selection_label}`);
      }
      if (runnerMatch.reason === "live_runner_ambiguous") {
        throw new MarketSemanticRejectError(
          `Betfair request-catalog live runner ambiguous (${runnerMatch.count} matches): ${payload.selection_label}`
        );
      }
      // "runner_ambiguous" -- the selection_id+canonical-name filter
      // matched 0 or >1 named runners: a definitive, evidence-based
      // rejection (Paddy/Betfair share selection_id across DIFFERENT
      // market_ids, so this is never safe to silently re-resolve via a
      // looser DOM name-only match).
      const runnerHints = (Array.isArray(sportsbookMarket.runners) ? sportsbookMarket.runners : [])
        .slice(0, 8)
        .map((runner) => ({
          selection_id: String((runner && runner.selectionId) || ""),
          name: String((runner && runner.name) || ""),
          handicap: runner && runner.handicap,
        }));
      throw new MarketSemanticRejectError(
        `Selection not found unambiguously in Betfair request catalog: ${payload.selection_label}; ` +
        `catalog runners: ${JSON.stringify(runnerHints)}`
      );
    }
    const { namedRunner, liveRunner, matchedKey } = runnerMatch;

    // Task "Line evidence" (spec-B item 5) / all-blind rejection (ported
    // from MINE, generalized to the catalog shape): the expected line must
    // be confirmed by at least one of the matched card's own title text,
    // the matched runner's own name text, or a genuinely usable runner
    // handicap field -- reject before implyBets if NONE of them ever did.
    const expectedLine = payload.expected_line !== null && payload.expected_line !== undefined
      ? payload.expected_line
      : runnerMatch.expectedLine;
    const evidence = catalogLineEvidenceOk({
      expectedLine,
      matchedTitle,
      matchedKey,
      namedRunner,
      liveRunner,
    });
    if (!evidence.ok) {
      // All-blind rejection is a definitive evidence-based decision, not an
      // infra hiccup -- never rescued by the DOM fallback's own (weaker)
      // matcher.
      throw new MarketSemanticRejectError(
        `Betfair request-catalog line could not be independently verified for "${payload.selection_label}" ` +
        `(reason: ${evidence.reason}, expected line ${expectedLine})`
      );
    }

    const actualOdds = Number(liveRunner.odds?.decimal ?? liveRunner.displayOdds?.decimal);
    if (!oddsEquivalent(actualOdds, payload.expected_odds)) {
      throw new Error(`Sportsbook price changed: expected ${payload.expected_odds}, got ${actualOdds}`);
    }
    return {
      ok: true,
      status: "MARKET_RESOLVED",
      provider: "betfair-sportsbook",
      resolution_mode: "graphql_requests",
      event_mapping_mode: eventMappingMode,
      requested_event_url: payload.event_url,
      event_url: effectiveEventUrl,
      betfair_market_id: betfairMarketId,
      betfair_selection_id: String(namedRunner.selectionId),
      market_name: String(sportsbookMarket.name || payload.market_name),
      selection: String(namedRunner.name || payload.selection),
      odds: actualOdds,
      catalog_market_count: marketIds.length,
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    activeRequestDryRun = true;
  }
}

// Reconcile regress1 P2 (final cross-family audit, money-safety): the
// direct-API loopback ("/fixed-odds-request" with stage=place,
// dryRun=false) is a second, independent path to a REAL Betfair
// placement -- previously it placed for real with no env/token check of
// its own at all, relying entirely on server.py's
// ROBINARB_BETFAIR_LIVE_PLACE_ENABLED gate never calling it when live
// placement is disabled. Defense-in-depth (liveBetfairPlaceEnabled, see
// betfair_sportsbook_live_gate.cjs): the worker itself now also refuses a
// live place() unless the SAME env var is enabled in its own process, so a
// bug/bypass in the server-side gate (or a stray direct call to this
// endpoint) cannot place real money.
async function fixedOddsRequest(body) {
  const stage = String((body || {}).stage || "").trim().toLowerCase();
  const url = FIXED_ODDS_URLS[stage];
  const payload = body && body.payload && typeof body.payload === "object" ? body.payload : null;
  if (!url) throw new Error("fixed-odds stage must be imply, prices, or place");
  if (!payload) throw new Error("fixed-odds payload object is required");
  if (stage === "place" && typeof payload.dryRun !== "boolean") {
    throw new Error("place payload must include dryRun boolean");
  }
  if (stage === "place" && payload.dryRun === false && !liveBetfairPlaceEnabled()) {
    throw new Error(
      `${LIVE_PLACE_ENV_VAR} is not enabled -- refusing a real Betfair fixed-odds placement from the worker ` +
      `loopback endpoint (defense-in-depth: this gate must be enabled in the worker's own process too)`
    );
  }

  const target = await ensureBrowser();
  const livePlace = stage === "place" && payload.dryRun === false;
  activeRequestDryRun = !livePlace;
  try {
    const result = await target.evaluate(async ({ requestUrl, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        credentials: "include",
        headers: { accept: "*/*", "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const raw = await response.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      return {
        upstream_status: response.status,
        content_type: response.headers.get("content-type") || "",
        data,
        body_prefix: data === null ? raw.slice(0, 500) : "",
      };
    }, { requestUrl: url, requestBody: payload });
    return { ok: true, status: "FIXED_ODDS_RESPONSE", stage, ...result };
  } finally {
    activeRequestDryRun = true;
  }
}

async function requestCatalogCards(target, eventId, marketIds, cardType) {
  const requestUrl = `https://apitbd.betfair.com/api/tbd/bff-gql/v11/?_ak=${FIXED_ODDS_APP_KEY}&currentViewUrn=${encodeURIComponent(`ppb:tbd:view:event:${eventId}?=tab=all-markets`)}`;
  const requestBody = {
    variables: {
      urn: marketIds.map((marketId) => `ppb:tbd:card:${cardType}:${marketId}|0|false|false|true|0||`),
      numberOfFilledCardsInCardGroup: 2,
      preferences: {
        userProducts: ["SPORTSBOOK", "GAMES"],
        favoriteSports: ["ppb:eventType:1", "ppb:eventType:2", "ppb:eventType:3503"],
      },
      productExclusions: [],
      experiments: [],
    },
    documentId: "Card#40a8e68b27ffbca0e7be3ce942064101",
  };
  const result = await target.evaluate(async ({ url, payload }) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { accept: "*/*", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { upstream_status: response.status, data, body_prefix: data === null ? raw.slice(0, 500) : "" };
  }, { url: requestUrl, payload: requestBody });
  if (result.upstream_status !== 200 || !result.data || result.data.errors) {
    throw new Error(`Betfair catalog request failed HTTP ${result.upstream_status}: ${JSON.stringify(result.data?.errors || result.body_prefix)}`);
  }
  return result.data;
}

async function requestEventSearch(target, query) {
  const result = await target.evaluate(async ({ url, payload }) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { accept: "*/*", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { upstream_status: response.status, data, body_prefix: data === null ? raw.slice(0, 500) : "" };
  }, {
    url: `https://apitbd.betfair.com/api/tbd/bff-gql/v11/?_ak=${FIXED_ODDS_APP_KEY}`,
    payload: {
      variables: {
        query,
        preferences: {
          userProducts: ["SPORTSBOOK", "GAMES"],
          favoriteSports: ["ppb:eventType:1", "ppb:eventType:2", "ppb:eventType:3503"],
        },
        productExclusions: [],
        experiments: [],
      },
      documentId: "SearchView#a2f3fa92545de5b1c4dd432e666608ab",
    },
  });
  if (result.upstream_status !== 200 || !result.data || result.data.errors) {
    throw new Error(`Betfair event search failed HTTP ${result.upstream_status}: ${JSON.stringify(result.data?.errors || result.body_prefix)}`);
  }
  return result.data;
}

const SPORTSBOOK_ACTIVITY_URL = "https://myactivity.betfair.com/activity/sportsbook";
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 20;

async function requestSportsbookActivity(target, status, fromRecord) {
  return target.evaluate(async ({ url, payload }) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { status: response.status, data, body_prefix: data === null ? raw.slice(0, 300) : "" };
  }, {
    url: SPORTSBOOK_ACTIVITY_URL,
    payload: {
      status,
      dateFilter: status === "SETTLED" ? 90 : 0,
      fromRecord,
      pageSize: RECONCILE_PAGE_SIZE,
      oddsType: "decimal",
    },
  });
}

async function loadSportsbookActivityRecords(target, status) {
  let fromRecord = 0;
  const records = [];
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < RECONCILE_MAX_PAGES; pageIndex += 1) {
    const response = await requestSportsbookActivity(target, status, fromRecord);
    if (response.status !== 200 || !response.data || !Array.isArray(response.data.bets)) {
      throw new Error(`Betfair activity ${status} failed HTTP ${response.status}: ${response.body_prefix || "invalid response"}`);
    }
    for (const record of response.data.bets) {
      const stableKey = [record.entryServiceId, record.betId, record.receiptBetId]
        .map((value) => String(value ?? "").trim())
        .join("|");
      if (!stableKey || seen.has(stableKey)) continue;
      seen.add(stableKey);
      records.push(record);
    }
    if (!response.data.moreAvailable) return { outcome: "complete", records };
    const next = Number(response.data.nextPageIndex);
    fromRecord = Number.isInteger(next) && next > fromRecord ? next : fromRecord + RECONCILE_PAGE_SIZE;
  }
  return { outcome: "page_limit" };
}

async function reconcileSportsbookBet(body) {
  const identifier = String((body || {}).order_id || "").trim();
  const intent = body && typeof body.intent === "object" ? body.intent : null;
  if (!identifier && !intent) throw new Error("order_id or intent is required");
  const target = await ensureBrowser();
  activeRequestDryRun = true;

  // Login is rendered asynchronously in the shared site header. Waiting for
  // either the username field or the account header prevents a fresh worker
  // from mistaking a not-yet-rendered login form for an authenticated page.
  await target.goto("https://www.betfair.com/betting/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await acceptCookies(target);
  await Promise.race([
    target.locator('input[name="username"]').waitFor({ state: "visible", timeout: 8000 }),
    target.getByText("My Account", { exact: true }).first().waitFor({ state: "visible", timeout: 8000 }),
  ]).catch(() => {});
  await ensureLoggedIn(target, "https://www.betfair.com/betting/");
  await target.goto("https://myactivity.betfair.com/sportsbook", { waitUntil: "domcontentloaded", timeout: 45000 });

  const records = [];
  for (const status of ["OPEN", "SETTLED"]) {
    const loaded = await loadSportsbookActivityRecords(target, status);
    if (loaded.outcome === "page_limit") {
      return { ok: true, ...unknownResult(identifier, "RECONCILIATION_PAGE_LIMIT") };
    }
    records.push(...loaded.records);
  }
  const match = identifier
    ? findUniqueBetRecord(records, identifier)
    : findUniqueBetByIntent(records, intent);
  if (match.outcome === "found") return { ok: true, ...placedResult(match.record) };
  if (match.outcome === "ambiguous") {
    return {
      ok: true,
      ...unknownResult(identifier, identifier ? "BET_ID_AMBIGUOUS" : "BET_INTENT_AMBIGUOUS", { matches: match.count }),
    };
  }
  // Money-safety invariant: absence from activity can be indexing delay, an
  // old record outside the 90-day window, or an identifier mismatch. It is
  // never affirmative proof that no live bet exists and can never refund.
  return { ok: true, ...unknownResult(identifier, identifier ? "BET_NOT_FOUND" : "BET_INTENT_NOT_FOUND") };
}


async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    json(res, 200, {
      available: true,
      status: page && !page.isClosed() ? "READY" : "IDLE",
      // Worker supports both dry-run and live placement, selected per-request
      // by the caller's dry_run flag; the live gate itself lives in the backend
      // (ROBINARB_BETFAIR_LIVE_PLACE_ENABLED), not here.
      mode: "sportsbook_betslip",
      browser_started: Boolean(page && !page.isClosed()),
      account_configured: Boolean(process.env.BETFAIR_USERNAME && process.env.BETFAIR_PASSWORD),
      proxy_configured: Boolean(process.env.BETFAIR_PROXY || process.env.PADDY_SPORTSBOOK_PROXY),
      real_submit_supported: true,
      // Reflects the current network route-guard state: placement POSTs are
      // blocked while idle (safe default) and only opened during a live click.
      submit_blocked: activeRequestDryRun,
      blocked_submit_count: blockedSubmitCount,
      last_result: lastResult,
      last_error: lastError || null,
    });
    return;
  }
  if (req.method === "GET" && req.url === "/session-cookies") {
    try {
      const cookie = await sessionCookies();
      if (!cookie) {
        json(res, 409, {
          ok: false,
          status: "SESSION_UNAVAILABLE",
          detail: "no active Betfair session cookies (browser not logged in yet)",
        });
        return;
      }
      json(res, 200, { ok: true, cookie, cookie_count: cookie.split("; ").length });
    } catch (error) {
      json(res, 500, {
        ok: false,
        status: "SESSION_UNAVAILABLE",
        detail: error && error.message ? error.message : String(error),
      });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/fixed-odds-request") {
    try {
      const body = await readBody(req);
      const task = queue.then(() => fixedOddsRequest(body));
      queue = task.catch(() => {});
      json(res, 200, await task);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      json(res, 422, { ok: false, status: "FIXED_ODDS_REQUEST_FAILED", detail: lastError });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/resolve-market") {
    try {
      const body = await readBody(req);
      const task = queue.then(() => resolveMarket(body));
      queue = task.catch(() => {});
      json(res, 200, await task);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      // Reconcile regress1 P1-2 (money-critical): a MarketSemanticRejectError
      // is a DEFINITIVE decision by the strict catalog matcher/evidence
      // gates -- report it as "MARKET_REJECTED" (never
      // "MARKET_RESOLVE_FAILED") so the Python client/server.py never treat
      // it as a safe-to-retry infra failure and fall back to the permissive
      // DOM basket path.
      const status = error instanceof MarketSemanticRejectError ? "MARKET_REJECTED" : "MARKET_RESOLVE_FAILED";
      json(res, 422, { ok: false, status, detail: lastError });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/reconcile-bet") {
    let identifier = "";
    try {
      const body = await readBody(req);
      identifier = String(body.order_id || "").trim();
      const task = queue.then(() => reconcileSportsbookBet(body));
      queue = task.catch(() => {});
      json(res, 200, await task);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      // Read-only reconciliation failures are always UNKNOWN. Returning an
      // explicit successful envelope prevents callers from interpreting a
      // transport/login failure as proof that the original bet was rejected.
      json(res, 200, {
        ok: true,
        ...unknownResult(identifier, "RECONCILIATION_FAILED", { detail: lastError }),
      });
    }
    return;
  }
  if (req.method !== "POST" || req.url !== "/basket") {
    json(res, 404, { ok: false, status: "NOT_FOUND" });
    return;
  }
  try {
    const body = await readBody(req);
    const task = queue.then(() => prepareBetslip(body));
    queue = task.catch(() => {});
    json(res, 200, await task);
  } catch (error) {
    lastError = error && error.message ? error.message : String(error);
    json(res, 422, { ok: false, status: "BETSLIP_REJECTED", detail: lastError, dry_run: true });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Betfair Sportsbook dry-run worker listening on http://${HOST}:${PORT}\n`);
});

async function shutdown() {
  server.close();
  if (context) await context.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
