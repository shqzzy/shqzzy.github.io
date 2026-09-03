/* popup.js — Stock valuation lookup via Supabase REST API (PostgREST) */
"use strict";

const $ = (id) => document.getElementById(id);

/* ================== Tunables ==================
 * If the conventions in your database differ, only this block needs changing —
 * the rendering logic below stays untouched.
 */
const TABLE = (typeof SUPABASE_TABLE === "string" && SUPABASE_TABLE) || "stocks";

// Every field rendered by the extension (column names must match the Supabase table)
const FIELDS = [
  "ticker",
  "company_name",
  "realtime_price",
  "dcf_price",
  "target_18m",
  "target_5y",
  "portfolio_level",
  "total_debt_musd",
  "net_cash_musd",
  "net_profit_musd",
  "cash_assets_musd",
  "fcf_musd",
  "trailing_pe",
  "median_pe",
  "dividends_pct",
  "expense_health_score",
];

// Optional fields: silently dropped if the column is missing
const OPTIONAL_FIELDS = ["update_time"];

// dividends_pct scale: stored 2.5 means 2.5% -> false; stored 0.025 means 2.5% -> true
const DIVIDEND_PCT_IS_FRACTION = false;

// ===== Metric definitions =====
// Data is parsed from Value Line reports; both "rank" fields follow Value Line's own scale:

/* 1) portfolio_level -> Value Line Safety™ rank
 *    Scale of 1-5, where 1 = safest and 5 = riskiest. Lower is safer (counter-intuitive:
 *    do NOT sort it like a percentage). Stored values may be "2" / "Safety 2" / the number
 *    2 / legacy values such as "Core" - the renderer handles all of them.
 */
const SAFETY_LEVELS = {
  1: { label: "Safest",   cls: "s1", desc: "Exceptionally strong finances, highest resilience" },
  2: { label: "High",     cls: "s2", desc: "Solid finances with a wide margin of safety" },
  3: { label: "Moderate", cls: "s3", desc: "Average safety; monitor cash flow and leverage" },
  4: { label: "Low",      cls: "s4", desc: "Weaker safety, higher volatility and credit risk" },
  5: { label: "Riskiest", cls: "s5", desc: "Lowest safety, often high leverage or unstable earnings" },
};

/* 2) expense_health_score -> Expense Health Score (0-10 scale)
 *    Ten-point scale (NOT a percentage). Higher is healthier.
 */
const SCORE_MAX = 10;
const SCORE_BANDS = [
  { min: 8,  cls: "good", label: "Excellent", desc: "Tight cost control, strong operating efficiency" },
  { min: 6,  cls: "mid",  label: "Good",      desc: "Broadly healthy cost structure, room to improve" },
  { min: 4,  cls: "mid",  label: "Fair",      desc: "Moderate expense pressure, track the expense ratio" },
  { min: 0,  cls: "bad",  label: "Weak",      desc: "Heavy cost burden, efficiency under strain" },
];

const DEBUG = true;           // Logs actual field types to the console; set false once verified

const PAGE_LIMIT = 30;        // Max rows returned per search

// ===== Popup sizing =====
// The popup width follows the active view: wide enough for the 9-column
// leaderboard, back to a compact width for search / detail.
const POPUP_W_NARROW = 400;   // Search, detail, match list
const POPUP_W_WIDE   = 640;   // Leaderboard — fits all 9 columns, no scrollbar
const POPUP_MAX_H    = 600;   // Chrome caps popups around 800x600

// ===== Landing ranking =====
const RANK_TOP_N = 10;        // How many rows the leaderboard shows
const RANK_MAX_ROWS = 5000;   // Cap on full-table fetch, so a huge table cannot stall the UI
const RANK_CACHE_TTL = 5 * 60 * 1000;  // Leaderboard cache: 5 minutes
const TIMEOUT_MS = 12000;     // Request timeout (ms)
const AUTO_SEARCH_MIN = 3;    // Auto-search after this many characters
const DEBOUNCE_MS = 320;      // Input debounce
const CACHE_TTL = 60 * 1000;  // Search result cache lifetime

/* ================== Number & formatting helpers ================== */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * Safe string cast: accepts any type and never throws.
 * Column types vary (enum -> string, jsonb -> object, codes -> number, multi-select -> array),
 * so calling .toLowerCase() on a raw value can crash. Everything textual goes through here.
 * - string  -> as-is
 * - number / boolean → String()
 * - array   -> joined with ", "
 * - object  -> uses name/label/value/text/level, else JSON
 */
function str(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") {
    for (const k of ["name", "label", "value", "text", "level"]) {
      if (typeof v[k] === "string" && v[k]) return v[k];
    }
    try { return JSON.stringify(v); } catch (e) { return ""; }
  }
  return "";
}

/** Prices: $1,234.56 */
function fmtPrice(v) {
  const n = num(v);
  if (n === null) return "--";
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Amounts (USD millions): rolls up to B once >= 1 billion */
function fmtMusd(v) {
  const n = num(v);
  if (n === null) return "--";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000) {
    return sign + "$" + (abs / 1000).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + "B";
  }
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "M";
}

/** Multiples / ratios such as P/E */
function fmtRatio(v) {
  const n = num(v);
  if (n === null) return "--";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Yields: multiplies by 100 when DIVIDEND_PCT_IS_FRACTION is true */
function fmtYield(v) {
  const n = num(v);
  if (n === null) return "--";
  const pct = DIVIDEND_PCT_IS_FRACTION ? n * 100 : n;
  return pct.toFixed(2) + "%";
}

/** Decimal ratio -> signed percentage (0.123 -> +12.3%) */
function fmtPct(v) {
  const n = num(v);
  if (n === null) return "--";
  const sign = n > 0 ? "+" : "";
  return sign + (n * 100).toFixed(1) + "%";
}

function fmtTime(iso) {
  if (typeof iso !== "string" && typeof iso !== "number") return "--";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  return d.toLocaleString("en-US", { hour12: false });
}

function calcCAGR(start, end, years) {
  const s = num(start), e = num(end);
  if (s === null || e === null || s <= 0 || e <= 0 || !years || years <= 0) return null;
  return Math.pow(e / s, 1 / years) - 1;
}

/** Paint positive/negative values consistently */
function paint(el, n, invert = false) {
  el.classList.remove("pos", "neg");
  if (n === null) return;
  const good = invert ? n < 0 : n > 0;   // pass invert=true for "lower is better" metrics such as P/E premium
  el.classList.add(good ? "pos" : "neg");
}

/* ================== Status helpers ================== */
function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.hidden = false;
  el.className = "status" + (isError ? " error" : "");
}
function hideStatus() { $("status").hidden = true; }
function setConn(state) {
  $("conn-dot").className = "conn-dot" + (state ? " " + state : "");
}

/**
 * Resizes the popup to match the active view.
 * Chrome sizes a popup from the body box, so setting --popup-w on :root is
 * enough. Wide only for the leaderboard; everything else stays compact.
 */
function setPopupSize(wide) {
  const root = document.documentElement;
  root.style.setProperty("--popup-w", (wide ? POPUP_W_WIDE : POPUP_W_NARROW) + "px");
  root.style.setProperty("--popup-max-h", POPUP_MAX_H + "px");
  document.body.classList.toggle("wide", !!wide);
}

function showSection(name) {
  $("empty").hidden = name !== "empty";
  $("result").hidden = name !== "result";
  $("list").hidden = name !== "list";
  $("ranking").hidden = name !== "ranking";

  // Only the leaderboard needs the extra width for its 9 columns
  setPopupSize(name === "ranking");
}

/* ================== Render: single stock detail ================== */
function renderDetail(row) {
  const rp = num(row.realtime_price);

  // Header
  $("ticker").textContent = str(row.ticker) || "--";
  $("company").textContent = str(row.company_name) || "--";
  setBadge($("portfolio-badge"), row.portfolio_level);

  // Hero
  $("realtime-price").textContent = fmtPrice(row.realtime_price);
  $("dcf-price").textContent = fmtPrice(row.dcf_price);

  const dp = num(row.dcf_price);
  const upsideEl = $("upside");
  if (rp !== null && rp > 0 && dp !== null) {
    const upside = (dp - rp) / rp;
    upsideEl.textContent = fmtPct(upside);
    paint(upsideEl, upside);
  } else {
    upsideEl.textContent = "--";
    upsideEl.classList.remove("pos", "neg");
  }

  // Price targets + CAGR
  setTarget("target-18m", "cagr-18m", row.target_18m, rp, 1.5);
  setTarget("target-5y", "cagr-5y", row.target_5y, rp, 5);

  // Valuation
  $("trailing-pe").textContent = fmtRatio(row.trailing_pe);
  $("median-pe").textContent = fmtRatio(row.median_pe);
  $("dividends-pct").textContent = fmtYield(row.dividends_pct);
  renderPeBar(num(row.trailing_pe), num(row.median_pe));

  // Financials (USD millions) — negative net cash / net profit / FCF show in red
  setSignedCell("total-debt", row.total_debt_musd, false);
  setSignedCell("net-cash", row.net_cash_musd, true);
  setSignedCell("net-profit", row.net_profit_musd, true);
  setSignedCell("cash-assets", row.cash_assets_musd, false);
  setSignedCell("fcf", row.fcf_musd, true);

  // Expense health score
  renderScore(num(row.expense_health_score));

  // Last updated
  $("update-time").textContent = fmtTime(row.update_time);

  showSection("result");
}

function setTarget(priceId, cagrId, target, rp, years) {
  $(priceId).textContent = fmtPrice(target);
  const el = $(cagrId);
  const cagr = calcCAGR(rp, target, years);
  if (cagr === null) {
    el.textContent = "";
    el.classList.remove("pos", "neg");
    return;
  }
  el.textContent = "CAGR " + fmtPct(cagr);
  paint(el, cagr);
}

/** Cell with sign semantics: negatives turn red when signSensitive is true */
function setSignedCell(id, value, signSensitive) {
  const el = $(id);
  el.textContent = fmtMusd(value);
  el.classList.remove("pos", "neg");
  if (signSensitive) {
    const n = num(value);
    if (n !== null && n < 0) el.classList.add("neg");
  }
}

/** Current P/E vs median P/E comparison bar */
function renderPeBar(t, m) {
  const bar = $("pe-bar"), fill = $("pe-fill"), marker = $("pe-marker"), gap = $("pe-gap");
  if (t === null || m === null || t <= 0 || m <= 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const max = Math.max(t, m) * 1.25;
  fill.style.width = Math.min(100, (t / max) * 100).toFixed(1) + "%";
  marker.style.left = Math.min(100, (m / max) * 100).toFixed(1) + "%";

  const diff = (t - m) / m;                 // >0 = premium (expensive), <0 = discount (cheap)
  fill.classList.remove("hot", "cold");
  fill.classList.add(diff > 0 ? "hot" : "cold");
  gap.textContent = (diff > 0 ? "Premium " : "Discount ") + fmtPct(diff);
  paint(gap, diff, true);
}

/**
 * Expense Health Score (0-10 scale, higher is healthier).
 * The bar normalises v / SCORE_MAX; colour and wording come from SCORE_BANDS.
 */
function renderScore(v) {
  const fill = $("score-fill"), txt = $("expense-health-score"), note = $("score-note");
  if (v === null) {
    fill.style.width = "0%";
    fill.className = "score-fill";
    txt.textContent = "--";
    txt.classList.remove("pos", "neg");
    note.textContent = "No data";
    return;
  }
  const p = Math.max(0, Math.min(100, (v / SCORE_MAX) * 100));
  const band = SCORE_BANDS.find((b) => v >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];

  fill.style.width = p.toFixed(1) + "%";
  fill.className = "score-fill " + band.cls;

  txt.textContent = v + " / " + SCORE_MAX;
  txt.classList.remove("pos", "neg");
  if (band.cls === "good") txt.classList.add("pos");
  else if (band.cls === "bad") txt.classList.add("neg");

  note.textContent = band.label + " · " + band.desc;
  note.className = "score-note" + (band.cls === "good" ? " pos" : band.cls === "bad" ? " neg" : "");
}

/**
 * Detects the Value Line Safety™ rank (1-5) from portfolio_level.
 * Accepts "2" / "Safety 2" / number 2 / arrays / jsonb.
 * Returns null for non-Safety values (e.g. legacy "Core") so the generic badge is used.
 */
function parseSafety(v) {
  const s = str(v).trim();
  if (!s) return null;
  const m = s.match(/\b([1-5])\b/);
  if (!m) return null;
  const rank = Number(m[1]);
  const meta = SAFETY_LEVELS[rank];
  return { rank, raw: s, label: meta.label, cls: meta.cls, desc: meta.desc };
}

/** Header badge: prefers the Value Line Safety™ style, falls back to generic levels */
function setBadge(el, level) {
  const noteEl = $("portfolio-note");
  const text = str(level).trim();

  if (!text) {
    el.className = "badge";
    el.textContent = "--";
    el.title = "Value Line Safety™ rank 1–5, where 1 = safest";
    if (noteEl) { noteEl.textContent = "Safety n/a"; noteEl.className = "head-note"; }
    return;
  }

  const safe = parseSafety(level);
  if (safe) {
    el.className = "badge safety " + safe.cls;
    el.textContent = "Safety " + safe.rank;
    el.title = "Value Line Safety™ " + safe.rank + "/5 · " + safe.label
      + " (1 = safest, 5 = riskiest)\n" + safe.desc;
    if (noteEl) {
      noteEl.textContent = "Safety™ " + safe.rank + "/5 · " + safe.label;
      noteEl.className = "head-note " + safe.cls;
      noteEl.title = safe.desc;
    }
    return;
  }

  // Non-Safety legacy value
  const s = text.toLowerCase();
  let cls = "";
  if (s.includes("core")) cls = " lv-core";
  else if (s.includes("sat")) cls = " lv-sat";
  else if (s.includes("spec") || s.includes("aggr")) cls = " lv-spec";
  else if (s.includes("watch")) cls = " lv-watch";
  el.className = "badge" + cls;
  el.textContent = text;
  el.title = "Portfolio level: " + text;
  if (noteEl) { noteEl.textContent = ""; noteEl.className = "head-note"; }
}

/* ================== Render: multiple matches ================== */
let listRows = [];
let activeIndex = -1;

function renderList(rows) {
  const body = $("list-body");
  body.innerHTML = "";
  listRows = rows;
  activeIndex = -1;

  rows.forEach((r) => {
    const item = document.createElement("div");
    item.className = "list-item";

    const t = document.createElement("span");
    t.className = "t";
    t.textContent = str(r.ticker) || "--";

    const c = document.createElement("span");
    c.className = "c";
    c.textContent = str(r.company_name) || "--";

    const p = document.createElement("span");
    p.className = "p";
    p.textContent = fmtPrice(r.realtime_price);

    item.append(t, c, p);
    const safe = parseSafety(r.portfolio_level);
    if (safe) {
      const l = document.createElement("span");
      l.className = "lvl " + safe.cls;
      l.textContent = "Safety " + safe.rank + " · " + safe.label;
      item.appendChild(l);
    } else {
      const lvlText = str(r.portfolio_level).trim();
      if (lvlText) {
        const l = document.createElement("span");
        l.className = "lvl";
        l.textContent = lvlText;
        item.appendChild(l);
      }
    }
    item.addEventListener("click", () => renderDetail(r));
    body.appendChild(item);
  });

  $("list-count").textContent = rows.length >= PAGE_LIMIT
    ? "Top " + PAGE_LIMIT + " shown"
    : rows.length + " found";
  showSection("list");
}

function setActive(i) {
  const items = $("list-body").children;
  if (!items.length) return;
  activeIndex = (i + items.length) % items.length;
  for (let k = 0; k < items.length; k++) {
    items[k].classList.toggle("active", k === activeIndex);
  }
  items[activeIndex].scrollIntoView({ block: "nearest" });
}

/* ================== Landing leaderboard: 18M target CAGR Top N ================== */
let rankRows = [];       // Raw rows behind the leaderboard, so a click can open the detail view

/** Computes CAGR, sorts by the 18M figure descending and keeps the top N.
 *  Rows missing a price or a target are dropped. */
function computeRanking(rows) {
  return rows
    .map((r) => {
      const rp = num(r.realtime_price);
      const t18 = num(r.target_18m);
      return {
        row: r,
        rp,
        cagr18: calcCAGR(rp, t18, 1.5),
        cagr5: calcCAGR(rp, num(r.target_5y), 5),
      };
    })
    .filter((x) => x.cagr18 !== null && x.rp > 0)
    .sort((a, b) =>
      b.cagr18 - a.cagr18 || str(a.row.ticker).localeCompare(str(b.row.ticker))
    )
    .slice(0, RANK_TOP_N);
}

function renderRanking(items, meta) {
  const body = $("rank-body");
  body.innerHTML = "";
  rankRows = items.map((x) => x.row);

  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "rank-empty";
    td.colSpan = 9;
    td.textContent = "No stock has a computable CAGR (needs both a current price and an 18-month target)";
    tr.appendChild(td);
    body.appendChild(tr);
  }

  items.forEach((x, i) => {
    const r = x.row;
    const tr = document.createElement("tr");
    tr.className = "rank-row";
    tr.addEventListener("click", () => { renderDetail(r); hideStatus(); });

    // Rank
    const idx = document.createElement("td");
    idx.className = "col-idx";
    idx.textContent = String(i + 1);
    if (i < 3) idx.classList.add("top" + (i + 1));

    // Ticker / company
    const tk = document.createElement("td");
    tk.className = "col-tk";
    const tkMain = document.createElement("span");
    tkMain.className = "tk-main";
    tkMain.textContent = str(r.ticker) || "--";
    const tkSub = document.createElement("span");
    tkSub.className = "tk-sub";
    tkSub.textContent = str(r.company_name) || "--";
    tkSub.title = str(r.company_name);
    tk.append(tkMain, tkSub);

    // 18M CAGR (primary sort column, emphasised)
    const c18 = document.createElement("td");
    c18.className = "col-cagr num";
    c18.textContent = fmtPct(x.cagr18);
    c18.classList.add(x.cagr18 >= 0 ? "pos" : "neg");

    // 5Y CAGR
    const c5 = document.createElement("td");
    c5.className = "num";
    c5.textContent = x.cagr5 === null ? "--" : fmtPct(x.cagr5);
    if (x.cagr5 !== null) c5.classList.add(x.cagr5 >= 0 ? "pos" : "neg");

    // Debt
    const debt = document.createElement("td");
    debt.className = "num";
    debt.textContent = fmtMusd(r.total_debt_musd);

    // Net cash (red when negative)
    const cash = document.createElement("td");
    cash.className = "num";
    cash.textContent = fmtMusd(r.net_cash_musd);
    if (num(r.net_cash_musd) < 0) cash.classList.add("neg");

    // DCF
    const dcf = document.createElement("td");
    dcf.className = "num";
    dcf.textContent = fmtPrice(r.dcf_price);

    // Safety
    const sf = document.createElement("td");
    sf.className = "col-safe";
    const safe = parseSafety(r.portfolio_level);
    if (safe) {
      const b = document.createElement("span");
      b.className = "safety-chip " + safe.cls;
      b.textContent = safe.rank;
      b.title = "Value Line Safety™ " + safe.rank + "/5 · " + safe.label;
      sf.appendChild(b);
    } else {
      sf.textContent = str(r.portfolio_level) || "--";
    }

    // Expense health
    const sc = document.createElement("td");
    sc.className = "col-score num";
    const sv = num(r.expense_health_score);
    sc.textContent = sv === null ? "--" : String(sv);
    if (sv !== null) {
      const band = SCORE_BANDS.find((b) => sv >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
      sc.classList.add("s-" + band.cls);
      sc.title = "Expense health " + sv + "/" + SCORE_MAX + " · " + band.label;
    }

    tr.append(idx, tk, c18, c5, debt, cash, dcf, sf, sc);
    body.appendChild(tr);
  });

  $("rank-sub").textContent = meta || "";
  showSection("ranking");
}

function setRankState(state) {
  const wrap = $("rank-wrap"), err = $("rank-error");
  wrap.hidden = state !== "ready";
  err.hidden = state !== "error";
  $("rank-loading").hidden = state !== "loading";
}

let rankCache = null;
let rankSeq = 0;

async function loadRanking(force = false) {
  if (!checkConfig()) {
    setRankState("error");
    $("rank-error").textContent = "Set the Supabase URL and anon key in config.js first";
    showSection("ranking");
    return;
  }

  if (!force && rankCache && Date.now() - rankCache.t < RANK_CACHE_TTL) {
    renderRanking(rankCache.items, rankCache.meta);
    return;
  }

  const seq = ++rankSeq;
  setRankState("loading");
  showSection("ranking");

  try {
    const rows = await fetchAllRows();
    if (seq !== rankSeq) return;

    const total = rows.length;
    const items = computeRanking(rows);
    const usable = rows.filter((r) => num(r.realtime_price) > 0 && num(r.target_18m) > 0).length;
    const meta = total
      ? total + " stocks · " + usable + " rankable"
      : "";

    rankCache = { t: Date.now(), items, meta };
    setRankState("ready");
    renderRanking(items, meta);

    if (DEBUG) {
      console.log("[StockDCF] Leaderboard: " + total + " rows total, " + usable + " with a computable CAGR");
      items.forEach((x, i) =>
        console.log("  " + (i + 1) + ". " + str(x.row.ticker).padEnd(6) + fmtPct(x.cagr18))
      );
    }
  } catch (err) {
    if (seq !== rankSeq) return;
    setRankState("error");
    $("rank-error").textContent = explainError(err);
    setConn("err");
  }
}

/* ================== Data layer ================== */

/** Sanitises the keyword: strips PostgREST syntax and ilike wildcards so the query string cannot be injected */
function sanitize(q) {
  return q
    .replace(/[,().*%_:\\"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function checkConfig() {
  if (typeof SUPABASE_URL !== "string" || !SUPABASE_URL.startsWith("https://")) {
    setStatus("Set SUPABASE_URL in config.js first (must start with https://)", true);
    setConn("err");
    return false;
  }
  if (typeof SUPABASE_ANON_KEY !== "string" ||
      !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith("YOUR-")) {
    setStatus("Set SUPABASE_ANON_KEY in config.js first (anon public key)", true);
    setConn("err");
    return false;
  }
  return true;
}

const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key.toLowerCase());
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.rows;
  cache.delete(key.toLowerCase());
  return null;
}
function cacheSet(key, rows) {
  cache.set(key.toLowerCase(), { t: Date.now(), rows });
}

/**
 * Builds the PostgREST query string.
 * An empty q fetches the whole table (used by the leaderboard); opts supports order / limit / offset.
 */
function buildUrl(q, fields, opts = {}) {
  const parts = [];
  if (q) {
    const pattern = "*" + encodeURIComponent(q) + "*";
    parts.push("or=(ticker.ilike." + pattern + ",company_name.ilike." + pattern + ")");
  }
  parts.push("select=" + fields.join(","));
  parts.push("order=" + (opts.order || "ticker"));
  parts.push("limit=" + (opts.limit || PAGE_LIMIT));
  if (opts.offset) parts.push("offset=" + opts.offset);

  return SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + TABLE + "?" + parts.join("&");
}

/**
 * One request. opts can override the timeout (full-table fetches get longer).
 * With wantCount it sends a Prefer header and returns { rows, total }.
 */
async function requestRows(q, fields, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    };
    if (opts.wantCount) headers.Prefer = "count=exact";

    const resp = await fetch(buildUrl(q, fields, opts), { headers, signal: ctrl.signal });
    if (!resp.ok) {
      const body = await resp.text();
      const err = new Error("Supabase " + resp.status + ": " + body.slice(0, 200));
      err.status = resp.status;
      throw err;
    }
    const rows = (await resp.json()) || [];

    if (opts.wantCount) {
      // Content-Range: 0-999/1234
      const cr = resp.headers.get("Content-Range") || "";
      const m = cr.match(/\/(\d+)$/);
      return { rows, total: m ? Number(m[1]) : rows.length };
    }
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

/** Optional column (update_time) degrades on its own: retry without it on 42703 */
function isMissingColumn(err) {
  return err.status === 42703 || (err.status >= 400 && /update_time/.test(err.message));
}

/** Keyword search: try with optional fields, degrade on failure */
async function fetchRows(q) {
  try {
    return await requestRows(q, FIELDS.concat(OPTIONAL_FIELDS));
  } catch (err) {
    if (isMissingColumn(err)) return await requestRows(q, FIELDS);
    throw err;
  }
}

/**
 * Fetches the whole table (leaderboard). PostgREST caps a page at 1000 rows, so it pages
 * through up to RANK_MAX_ROWS rows to keep a large table from stalling the extension.
 */
async function fetchAllRows() {
  const PAGE = 1000;
  const timeout = Math.max(TIMEOUT_MS, 20000);
  const all = [];

  try {
    for (let offset = 0; offset < RANK_MAX_ROWS; offset += PAGE) {
      const res = await requestRows("", FIELDS.concat(OPTIONAL_FIELDS), {
        order: "ticker",
        limit: PAGE,
        offset,
        timeout,
      });
      all.push(...res);
      if (res.length < PAGE) break;      // last page
    }
    return all;
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    // No update_time column — retry without it
    const all2 = [];
    for (let offset = 0; offset < RANK_MAX_ROWS; offset += PAGE) {
      const res = await requestRows("", FIELDS, {
        order: "ticker", limit: PAGE, offset, timeout,
      });
      all2.push(...res);
      if (res.length < PAGE) break;
    }
    return all2;
  }
}

/** Turns raw errors into actionable messages */
function explainError(err) {
  if (err.name === "AbortError") return "Request timed out (>" + TIMEOUT_MS / 1000 + "s), please retry";
  if (/Failed to fetch|NetworkError/i.test(err.message)) {
    return "Network request failed: check that manifest host_permissions includes the Supabase domain";
  }
  const s = err.status;
  if (s === 401 || s === 403) return "Auth failed (" + s + "): wrong anon key, or RLS does not allow anon reads on this table";
  if (s === 404) return "404: table " + TABLE + " not found — check SUPABASE_TABLE in config.js";
  if (s === 42703) return "Column not found: compare Supabase column names with FIELDS in popup.js";
  return "Query failed: " + err.message;
}

/* ================== Main search ================== */
let searchSeq = 0;

async function search(rawQuery) {
  const raw = str(rawQuery).trim();
  if (!raw) { setStatus("Enter a ticker or company name", true); return; }

  const q = sanitize(raw);
  if (!q) { setStatus("Keyword contains no valid characters", true); return; }
  if (!checkConfig()) return;

  const seq = ++searchSeq;
  hideStatus();
  showSection("empty");
  setStatus("Searching…");
  setConn("busy");

  try {
    let rows = cacheGet(q);
    if (!rows) {
      rows = await fetchRows(q);
      cacheSet(q, rows);
    }
    if (seq !== searchSeq) return;           // a newer search was issued — discard this result

    // Field type check: surfaces columns whose type differs from what the UI expects
    if (DEBUG && rows.length) {
      const r = rows[0];
      console.log("[StockDCF] Field type check:");
      FIELDS.concat(OPTIONAL_FIELDS).forEach((f) => {
        const v = r[f];
        const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        const flag = /^(ticker|company_name|portfolio_level)$/.test(f) && v !== null && typeof v !== "string"
          ? "  <- should be string" : "";
        console.log("  " + f.padEnd(21) + t.padEnd(9) + JSON.stringify(v) + flag);
      });
    }

    if (!rows.length) {
      setStatus('No match for "' + raw + '"', true);
      setConn("ok");
      showSection("empty");
      return;
    }

    // A single hit, or an exact ticker match, opens the detail view directly — one click saved
    const key = q.toLowerCase();
    const exact = rows.find((r) => str(r.ticker).toLowerCase() === key);

    // Render is wrapped so one bad row cannot blank out the whole panel
    try {
      if (rows.length === 1 || exact) renderDetail(exact || rows[0]);
      else renderList(rows);
    } catch (renderErr) {
      console.error("[StockDCF] render failed", renderErr, rows[0]);
      setStatus("Render failed: " + renderErr.message + " (see console)", true);
      setConn("err");
      showSection("empty");
      return;
    }

    hideStatus();
    setConn("ok");
  } catch (err) {
    if (seq !== searchSeq) return;
    setStatus(explainError(err), true);
    setConn("err");
  }
}

/* ================== Event wiring ================== */
const input = $("search-input");

$("search-btn").addEventListener("click", () => search(input.value));

$("clear-btn").addEventListener("click", () => {
  input.value = "";
  $("clear-btn").hidden = true;
  hideStatus();
  listRows = [];
  activeIndex = -1;
  input.focus();
  // Restore the leaderboard from cache, or refetch
  if (rankCache) renderRanking(rankCache.items, rankCache.meta);
  else loadRanking();
});

let debounceTimer = null;
input.addEventListener("input", () => {
  $("clear-btn").hidden = !input.value;
  clearTimeout(debounceTimer);
  const v = input.value.trim();
  if (v.length < AUTO_SEARCH_MIN) return;
  debounceTimer = setTimeout(() => search(v), DEBOUNCE_MS);
});

input.addEventListener("keydown", (e) => {
  const listVisible = !$("list").hidden;
  if (e.key === "ArrowDown" && listVisible) { e.preventDefault(); setActive(activeIndex + 1); return; }
  if (e.key === "ArrowUp" && listVisible) { e.preventDefault(); setActive(activeIndex - 1); return; }
  if (e.key === "Enter") {
    if (listVisible && activeIndex >= 0) {
      e.preventDefault();
      renderDetail(listRows[activeIndex]);
      hideStatus();
      return;
    }
    clearTimeout(debounceTimer);
    search(input.value);
  }
  if (e.key === "Escape") {
    input.value = "";
    $("clear-btn").hidden = true;
    hideStatus();
    if (rankCache) renderRanking(rankCache.items, rankCache.meta);
    else loadRanking();
  }
});

/* Refresh the leaderboard */
$("rank-refresh").addEventListener("click", () => loadRanking(true));

window.addEventListener("DOMContentLoaded", () => {
  // The leaderboard is the landing view, so start wide and skip the
  // width animation on first paint (otherwise the popup slides open).
  document.body.classList.add("no-anim");
  setPopupSize(true);
  requestAnimationFrame(() => document.body.classList.remove("no-anim"));

  input.focus();
  loadRanking();        // Show the Top 10 leaderboard as soon as the popup opens
});
