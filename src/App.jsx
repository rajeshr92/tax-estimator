import React, { useState, useEffect, useRef, useMemo } from "react";

/* ================= 2026 FEDERAL TAX CONSTANTS (Rev. Proc. 2025-32) ================= */

const BRACKETS = {
  mfj: [
    [0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24],
    [403550, 0.32], [512450, 0.35], [768700, 0.37],
  ],
  single: [
    [0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24],
    [201775, 0.32], [256225, 0.35], [640600, 0.37],
  ],
  hoh: [
    [0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24],
    [201750, 0.32], [256200, 0.35], [640600, 0.37],
  ],
};

const STD_DEDUCTION = { mfj: 32200, single: 16100, hoh: 24150 };
const CTC_PER_CHILD = 2200;
const CTC_PHASEOUT_START = { mfj: 400000, single: 200000, hoh: 200000 };
const STATUS_LABELS = { mfj: "Married filing jointly", single: "Single", hoh: "Head of household" };

/* ================= DESIGN TOKENS ================= */

const T = {
  bg: "#EDF0F3",
  card: "#FFFFFF",
  ink: "#141E2B",
  inkSoft: "#4B5A6B",
  inkFaint: "#8494A6",
  line: "#D8DEE5",
  blue: "#2E5BFF",        // interactive / what-if
  blueSoft: "#EAF0FF",
  owe: "#C2452B",         // balance due
  oweSoft: "#FBEEEA",
  refund: "#1E7F5C",      // refund
  refundSoft: "#E9F5F0",
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  sans: '"Avenir Next", "Segoe UI", Inter, system-ui, sans-serif',
};

/* ================= HELPERS ================= */

const parseNum = (s) => {
  if (typeof s === "number") return isFinite(s) ? s : 0;
  const n = parseFloat(String(s ?? "").replace(/[$,%\s,]/g, ""));
  return isFinite(n) ? n : 0;
};
const fmt0 = (n) => (isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const fmt$ = (n) => (n < 0 ? "-$" + fmt0(-n) : "$" + fmt0(n));
const fmtPct = (n, d = 1) => (isFinite(n) ? (n * 100).toFixed(d) + "%" : "—");

function taxFromBrackets(taxable, status) {
  const br = BRACKETS[status];
  let tax = 0;
  for (let i = 0; i < br.length; i++) {
    const [lo, rate] = br[i];
    const hi = i + 1 < br.length ? br[i + 1][0] : Infinity;
    if (taxable <= lo) break;
    tax += (Math.min(taxable, hi) - lo) * rate;
  }
  return tax;
}

function marginalRate(taxable, status) {
  const br = BRACKETS[status];
  let rate = br[0][1];
  for (const [lo, r] of br) if (taxable > lo) rate = r;
  return taxable <= 0 ? 0 : rate;
}

function childTaxCredit(agi, kids, status) {
  if (!kids) return 0;
  const base = kids * CTC_PER_CHILD;
  const excess = Math.max(0, agi - CTC_PHASEOUT_START[status]);
  const reduction = Math.ceil(excess / 1000) * 50;
  return Math.max(0, base - reduction);
}

/* Core model. */
function computeModel(s) {
  const rsuRate = parseNum(s.rsuRate) / 100;
  const extraPerCheck = parseNum(s.extraPerCheck);
  const paychecks = Math.max(0, parseNum(s.remainingPaychecks));
  const extraWH = extraPerCheck * paychecks;

  const ytdEarn = parseNum(s.ytdEarnings);
  const ytdWH = parseNum(s.ytdWithheld);

  const futureSalary = parseNum(s.futureSalary);
  // Salary withholding rate — derived live from the chosen mode
  let salaryRate = 0;
  if (s.salaryWhMode === "ytd") {
    salaryRate = ytdEarn > 0 ? ytdWH / ytdEarn : 0;
  } else if (s.salaryWhMode === "bracket") {
    // Approximate standard W-4 payroll withholding: annualized salary less the
    // standard deduction, run through the regular tables. Step 2 (two jobs)
    // checked => payroll withholds on the higher single-style schedule.
    const base = parseNum(s.annualSalary);
    const sched = s.w4Step2 ? "single" : s.status;
    salaryRate = base > 0 ? taxFromBrackets(Math.max(0, base - STD_DEDUCTION[sched]), sched) / base : 0;
  } else {
    salaryRate = parseNum(s.salaryWhRate) / 100;
  }
  const salaryWH = futureSalary * salaryRate;

  const bonus = parseNum(s.bonus);
  let bonusRate = 0;
  if (s.bonusWhMode === "flat") {
    // IRS supplemental rate: 22% flat, 37% mandatory on supplemental wages over $1M
    const over = Math.max(0, bonus - 1000000);
    bonusRate = bonus > 0 ? ((bonus - over) * 0.22 + over * 0.37) / bonus : 0.22;
  } else if (s.bonusWhMode === "ytd") {
    bonusRate = ytdEarn > 0 ? ytdWH / ytdEarn : 0;
  } else if (s.bonusWhMode === "bracket") {
    // Aggregate method: the bonus stacks on top of annual salary, so it's
    // withheld at the incremental (marginal-ish) rate, not the average.
    const base = parseNum(s.annualSalary);
    const sched = s.w4Step2 ? "single" : s.status;
    const ded = STD_DEDUCTION[sched];
    bonusRate = bonus > 0 && base > 0
      ? (taxFromBrackets(Math.max(0, base + bonus - ded), sched) - taxFromBrackets(Math.max(0, base - ded), sched)) / bonus
      : 0;
  } else {
    bonusRate = parseNum(s.bonusRate) / 100;
  }
  const bonusWH = bonus * bonusRate;

  // Historical vests (quick entry)
  const vestedValue =
    s.vestedMode === "total"
      ? parseNum(s.vestedTotal)
      : parseNum(s.vestedShares) * parseNum(s.vestedAvgPrice);
  const vestedIncluded = s.vestedIncluded; // already inside YTD totals?
  const vestedIncome = vestedIncluded ? 0 : vestedValue;
  const vestedWH = vestedIncluded ? 0 : vestedValue * (parseNum(s.vestedRate) / 100);

  // Upcoming vests
  const globalPrice = parseNum(s.predictedPrice);
  let upcomingIncome = 0;
  const vestDetails = s.vests.map((v) => {
    const shares = parseNum(v.shares);
    const price = v.price !== "" ? parseNum(v.price) : globalPrice;
    const dollar = v.dollar ?? "";
    const computed = shares * price;
    const value = dollar !== "" ? parseNum(dollar) : computed; // typed $ wins over shares × price
    upcomingIncome += value;
    return { ...v, sharesN: shares, priceN: price, dollar, computed, value };
  });
  const upcomingWH = upcomingIncome * rsuRate;

  const otherIncome = parseNum(s.otherIncome);
  const otherWH = parseNum(s.otherWithholding);

  const totalIncome = ytdEarn + vestedIncome + futureSalary + bonus + upcomingIncome + otherIncome;
  const deduction =
    s.deductionMode === "custom"
      ? Math.max(parseNum(s.customDeduction), 0)
      : STD_DEDUCTION[s.status];
  const taxable = Math.max(0, totalIncome - deduction);

  const bracketTax = taxFromBrackets(taxable, s.status);
  const ctc = childTaxCredit(totalIncome, parseNum(s.kids), s.status);
  const otherAdj = parseNum(s.otherAdj);
  const liability = Math.max(0, bracketTax - ctc) + otherAdj;

  const withholding = ytdWH + salaryWH + bonusWH + vestedWH + upcomingWH + otherWH + extraWH;
  const gap = liability - withholding; // positive => balance due

  return {
    totalIncome, deduction, taxable, bracketTax, ctc, otherAdj, liability,
    withholding, gap, vestDetails, upcomingIncome, upcomingWH,
    salaryWH, salaryRate, bonusWH, bonusRate, vestedIncome, vestedWH, ytdEarn, ytdWH, otherWH,
    extraWH, extraPerCheck, paychecks,
    effRate: totalIncome > 0 ? liability / totalIncome : 0,
    margRate: marginalRate(taxable, s.status),
  };
}

/* ================= SMALL UI PIECES ================= */

function NumField({ label, value, onChange, prefix, suffix, hint, small, disabled }) {
  const [text, setText] = useState(value === 0 || value === "" ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      const n = parseNum(value);
      setText(value === "" || value == null ? "" : n === 0 ? (String(value) === "0" ? "0" : "") : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
    }
  }, [value]);
  return (
    <label style={{ display: "block", opacity: disabled ? 0.45 : 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", background: disabled ? "#F2F4F6" : "#FBFCFD", border: `1px solid ${T.line}`, borderRadius: 8, padding: "0 10px", height: small ? 34 : 40 }}>
        {prefix && <span style={{ color: T.inkFaint, fontFamily: T.mono, fontSize: 13, marginRight: 4 }}>{prefix}</span>}
        <input
          value={text}
          disabled={disabled}
          inputMode="decimal"
          onFocus={() => (focused.current = true)}
          onBlur={() => { focused.current = false; const n = parseNum(text); setText(text === "" ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 4 })); }}
          onChange={(e) => { setText(e.target.value); onChange(parseNum(e.target.value)); }}
          style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontFamily: T.mono, fontSize: small ? 13 : 15, color: T.ink, padding: 0 }}
          placeholder="0"
        />
        {suffix && <span style={{ color: T.inkFaint, fontFamily: T.mono, fontSize: 13, marginLeft: 4 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: T.inkFaint, marginTop: 4, lineHeight: 1.35 }}>{hint}</div>}
    </label>
  );
}

function Card({ eyebrow, title, children, tint }) {
  return (
    <section className="tp-card" style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: 18, boxShadow: "0 1px 2px rgba(20,30,43,0.04)" }}>
      {eyebrow && (
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: tint || T.blue, marginBottom: 2 }}>
          {eyebrow}
        </div>
      )}
      {title && <h2 style={{ fontSize: 16, fontWeight: 700, color: T.ink, margin: "0 0 12px" }}>{title}</h2>}
      {children}
    </section>
  );
}

function LineItem({ label, value, strong, indent, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", paddingLeft: indent ? 14 : 0, borderBottom: strong ? "none" : `1px dashed ${T.line}` }}>
      <span style={{ fontSize: strong ? 13.5 : 12.5, color: strong ? T.ink : T.inkSoft, fontWeight: strong ? 700 : 400 }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: strong ? 15 : 13, fontWeight: strong ? 700 : 500, color: color || T.ink }}>{value}</span>
    </div>
  );
}

/* Signature element: the balance beam — withholding vs liability with the gap hatched. */
function GapGauge({ m }) {
  const owe = m.gap > 0;
  const zero = Math.abs(m.gap) < 1;
  const max = Math.max(m.liability, m.withholding, 1) * 1.06;
  const wLiab = (m.liability / max) * 100;
  const wWith = (m.withholding / max) * 100;
  const gapLeft = Math.min(wLiab, wWith);
  const gapWidth = Math.abs(wLiab - wWith);
  const gapColor = owe ? T.owe : T.refund;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.inkSoft }}>
            {zero ? "On target" : owe ? "Projected balance due" : "Projected refund"}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 34, fontWeight: 700, color: zero ? T.ink : gapColor, lineHeight: 1.1 }}>
            {fmt$(Math.abs(m.gap))}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12, color: T.inkSoft, lineHeight: 1.5 }}>
          <div>Effective rate <span style={{ fontFamily: T.mono, fontWeight: 600, color: T.ink }}>{fmtPct(m.effRate)}</span></div>
          <div>Marginal rate <span style={{ fontFamily: T.mono, fontWeight: 600, color: T.ink }}>{fmtPct(m.margRate, 0)}</span></div>
        </div>
      </div>

      <div style={{ position: "relative", height: 64 }}>
        {/* liability bar */}
        <div style={{ position: "absolute", top: 4, left: 0, width: `${wLiab}%`, height: 20, background: T.ink, borderRadius: 4, transition: "width .3s" }} />
        {/* withholding bar */}
        <div style={{ position: "absolute", top: 30, left: 0, width: `${wWith}%`, height: 20, background: T.blue, borderRadius: 4, transition: "width .3s" }} />
        {/* gap hatch */}
        {gapWidth > 0.2 && (
          <div style={{
            position: "absolute", top: 0, left: `${gapLeft}%`, width: `${gapWidth}%`, height: 54,
            borderLeft: `2px solid ${gapColor}`, borderRight: `2px solid ${gapColor}`,
            background: `repeating-linear-gradient(45deg, ${gapColor}22 0 6px, transparent 6px 12px)`,
            borderRadius: 3, transition: "left .3s, width .3s",
          }} />
        )}
      </div>
      <div style={{ display: "flex", gap: 18, fontSize: 12, color: T.inkSoft }}>
        <span><span style={{ display: "inline-block", width: 10, height: 10, background: T.ink, borderRadius: 2, marginRight: 5 }} />Tax you'll owe · <span style={{ fontFamily: T.mono, color: T.ink }}>{fmt$(m.liability)}</span></span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, background: T.blue, borderRadius: 2, marginRight: 5 }} />Tax you'll have paid · <span style={{ fontFamily: T.mono, color: T.ink }}>{fmt$(m.withholding)}</span></span>
      </div>
    </div>
  );
}

/* Income stacked through the brackets */
function BracketBar({ taxable, status }) {
  const br = BRACKETS[status];
  const segs = [];
  for (let i = 0; i < br.length; i++) {
    const [lo, rate] = br[i];
    const hi = i + 1 < br.length ? br[i + 1][0] : Infinity;
    if (taxable <= lo) break;
    const amt = Math.min(taxable, hi) - lo;
    segs.push({ rate, amt, tax: amt * rate });
  }
  const total = Math.max(taxable, 1);
  const shades = ["#C9D4E0", "#A9BACB", "#8AA0B6", "#6B87A1", "#50708D", "#3A5B79", "#274764"];
  return (
    <div>
      <div style={{ display: "flex", height: 16, borderRadius: 4, overflow: "hidden", border: `1px solid ${T.line}` }}>
        {segs.map((s, i) => (
          <div key={i} title={`${fmtPct(s.rate, 0)} on ${fmt$(s.amt)}`} style={{ width: `${(s.amt / total) * 100}%`, background: shades[i] }} />
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        {segs.map((s, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.inkSoft, padding: "2px 0" }}>
            <span><span style={{ display: "inline-block", width: 9, height: 9, background: shades[i], borderRadius: 2, marginRight: 6 }} />{fmtPct(s.rate, 0)} bracket</span>
            <span style={{ fontFamily: T.mono }}>{fmt$(s.amt)} → {fmt$(s.tax)}</span>
          </div>
        ))}
        {segs.length === 0 && <div style={{ fontSize: 12, color: T.inkFaint }}>No taxable income yet — enter your numbers on the left.</div>}
      </div>
    </div>
  );
}

/* ================= DEFAULT STATE ================= */

const DEFAULTS = {
  status: "mfj",
  ytdEarnings: "", ytdWithheld: "",
  futureSalary: "", salaryWhMode: "ytd", salaryWhRate: 24, annualSalary: "", w4Step2: false,
  bonus: "", bonusWhMode: "flat", bonusRate: 22,
  vestedMode: "shares", vestedShares: "", vestedAvgPrice: "", vestedTotal: "", vestedRate: 22, vestedIncluded: true,
  predictedPrice: "", rsuRate: 22,
  vests: [{ id: 1, label: "Next vest", shares: "", price: "", dollar: "" }],
  otherIncome: "", otherWithholding: "", deductionMode: "standard", customDeduction: "",
  kids: "", otherAdj: "", extraPerCheck: "",
  remainingPaychecks: 12, priorYearTax: "",
};

const STORAGE_KEY = "federal-tax-planner-v1";
const NUX_KEY = "federal-tax-planner-nux-v1";

/* Example person for the intro walkthrough — real numbers run through the real model */
const DEMO = {
  ...JSON.parse(JSON.stringify(DEFAULTS)),
  ytdEarnings: 260000, ytdWithheld: 61000,
  futureSalary: 160000, salaryWhMode: "ytd",
  bonus: 40000, bonusWhMode: "flat",
  vestedIncluded: true,
  predictedPrice: 550, rsuRate: 22,
  vests: [
    { id: 1, label: "August", shares: 300, price: "", dollar: "" },
    { id: 2, label: "November", shares: 300, price: "", dollar: "" },
  ],
  kids: 1, priorYearTax: 190000, remainingPaychecks: 12,
};

/* ================= APP ================= */

export default function App() {
  const [s, setS] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const set = (k) => (v) => setS((p) => ({ ...p, [k]: v }));

  /* -------- track small screens for the mobile results bar -------- */
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const upd = () => setIsNarrow(mq.matches);
    upd();
    if (mq.addEventListener) mq.addEventListener("change", upd);
    else mq.addListener(upd);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", upd);
      else mq.removeListener(upd);
    };
  }, []);

  /* -------- persistence (survives page reloads) -------- */
  const [nuxOpen, setNuxOpen] = useState(false);
  const [nuxStep, setNuxStep] = useState(0);
  useEffect(() => {
    (async () => {
      let hasSaved = false, nuxDone = false;
      try {
        if (typeof window !== "undefined" && window.storage) {
          const r = await window.storage.get(STORAGE_KEY);
          if (r && r.value) {
            hasSaved = true;
            const saved = JSON.parse(r.value);
            setS({ ...DEFAULTS, ...saved, vests: saved.vests?.length ? saved.vests : DEFAULTS.vests });
          }
        }
      } catch (e) { /* first run: nothing saved yet */ }
      try {
        if (typeof window !== "undefined" && window.storage) {
          const n = await window.storage.get(NUX_KEY);
          if (n && n.value) nuxDone = true;
        }
      } catch (e) { /* nux not seen yet */ }
      if (!hasSaved && !nuxDone) setNuxOpen(true);
      // Test hook: append ?nux=1 to the URL to force the intro regardless of state
      try { if (new URLSearchParams(window.location.search).get("nux") === "1") setNuxOpen(true); } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const finishNux = async (loadExample) => {
    setNuxOpen(false);
    setNuxStep(0);
    try { if (window.storage) await window.storage.set(NUX_KEY, "done"); } catch (e) {}
    if (loadExample) setS(JSON.parse(JSON.stringify(DEMO)));
  };

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(async () => {
      try {
        if (typeof window !== "undefined" && window.storage) {
          await window.storage.set(STORAGE_KEY, JSON.stringify(s));
          setSavedAt(new Date());
        }
      } catch (e) { /* storage unavailable; keep working in-memory */ }
    }, 900);
    return () => clearTimeout(t);
  }, [s, loaded]);

  const resetAll = async () => {
    setS(DEFAULTS);
    try { if (window.storage) await window.storage.delete(STORAGE_KEY); } catch (e) {}
  };

  /* -------- model -------- */
  const m = useMemo(() => computeModel(s), [s]);
  const demoM = useMemo(() => computeModel(DEMO), []);

  /* -------- safe harbor: two independent prongs + tipping point -------- */
  const priorTax = parseNum(s.priorYearTax);
  const sh90 = 0.9 * m.liability;                     // 90% of current-year tax
  const sh110 = priorTax > 0 ? 1.1 * priorTax : null; // 110% of prior-year tax (AGI > $150k)
  const meets90 = m.withholding >= sh90 && m.liability > 0;
  const meets110 = sh110 != null && m.withholding >= sh110;
  const deMinimis = m.gap < 1000 && m.liability > 0;
  const safeHarborOK = meets90 || meets110 || deMinimis;
  // Crossover: the 2026 liability at which the cheaper target flips.
  // 0.9 × liability = 1.1 × priorTax  =>  liability = priorTax × 11/9
  const crossover = priorTax > 0 ? priorTax * (1.1 / 0.9) : null;
  const on90Side = crossover != null && m.liability < crossover;

  /* -------- vest row ops -------- */
  const addVest = () => setS((p) => ({ ...p, vests: [...p.vests, { id: Date.now(), label: `Vest ${p.vests.length + 1}`, shares: "", price: "", dollar: "" }] }));
  const rmVest = (id) => setS((p) => ({ ...p, vests: p.vests.filter((v) => v.id !== id) }));
  const updVest = (id, k, v) => setS((p) => ({ ...p, vests: p.vests.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));

  const ytdEff = parseNum(s.ytdEarnings) > 0 ? (parseNum(s.ytdWithheld) / parseNum(s.ytdEarnings)) * 100 : null;

  // Worked math shown inside bracket-mode boxes, so the rate is verifiable
  const salaryMath = useMemo(() => {
    const base = parseNum(s.annualSalary);
    const sched = s.w4Step2 ? "single" : s.status;
    const ded = STD_DEDUCTION[sched];
    const t = taxFromBrackets(Math.max(0, base - ded), sched);
    return { base, ded, t, sched };
  }, [s.annualSalary, s.w4Step2, s.status]);

  const seg = (active) => ({
    padding: "8px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", borderRadius: 7,
    border: `1px solid ${active ? T.blue : T.line}`, background: active ? T.blueSoft : "#FBFCFD",
    color: active ? T.blue : T.inkSoft,
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: T.sans, color: T.ink }}>
      <style>{`
        html, body { background: ${T.bg}; }
        body { overflow-x: clip; }
        .tp-verdict-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
          display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
          background: ${T.ink}; padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
          box-shadow: 0 -4px 16px rgba(20,30,43,0.25); }
        @media (min-width: 1024px) { .tp-verdict-bar { display: none; } }
        @media (max-width: 1023px) { .tp-container { padding-bottom: 120px !important; } }
        @media (max-width: 640px) {
          .tp-card { padding: 14px !important; }
          .tp-container { padding-left: 12px !important; padding-right: 12px !important; }
          .tp-title { font-size: 21px !important; }
        }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: isNarrow ? "18px 14px 130px" : "22px 16px 60px" }}>

        {/* ---------- header ---------- */}
        <header style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18, borderBottom: `2px solid ${T.ink}`, paddingBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.blue }}>Tax year 2026 · Federal only</div>
            <h1 className="tp-title" style={{ margin: "2px 0 0", fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>Withholding vs. What You'll Owe</h1>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ fontSize: 12, color: T.inkSoft, fontWeight: 600 }}>
              Filing status{" "}
              <select value={s.status} onChange={(e) => set("status")(e.target.value)}
                style={{ marginLeft: 6, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.line}`, background: "#fff", fontSize: 13, fontWeight: 600, color: T.ink }}>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <button onClick={() => { setNuxStep(0); setNuxOpen(true); }} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blueSoft, fontSize: 12, fontWeight: 600, color: T.blue, cursor: "pointer" }}>
              How it works
            </button>
            <button onClick={resetAll} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.line}`, background: "#fff", fontSize: 12, fontWeight: 600, color: T.inkSoft, cursor: "pointer" }}>
              Reset
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4" style={{ display: "grid", gap: 16 }}>
          {/* Tailwind grid classes handle responsiveness; inline grid is the fallback */}

          {/* ================= LEFT: INPUTS ================= */}
          <div className="lg:col-span-3" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            <Card eyebrow="Step 1" title="Year to date — what's already happened">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                <NumField label="Earnings so far (YTD)" prefix="$" value={s.ytdEarnings} onChange={set("ytdEarnings")}
                  hint="Total taxable comp YTD from your paystub — salary, bonus, and RSU income if your paystub includes it." />
                <NumField label="Federal tax withheld so far (YTD)" prefix="$" value={s.ytdWithheld} onChange={set("ytdWithheld")}
                  hint={ytdEff != null ? `Your YTD effective withholding rate is ${ytdEff.toFixed(1)}%.` : "Federal income tax line on your paystub."} />
              </div>
            </Card>

            <Card eyebrow="Step 2" title="Cash coming — rest of the year">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12, marginBottom: 12 }}>
                <NumField label="Remaining salary through Dec 31" prefix="$" value={s.futureSalary} onChange={set("futureSalary")} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 4 }}>
                    Withholding rate on salary
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={seg(s.salaryWhMode === "ytd")} onClick={() => set("salaryWhMode")("ytd")}>Track YTD rate</button>
                    <button style={seg(s.salaryWhMode === "bracket")} onClick={() => set("salaryWhMode")("bracket")}>Tax brackets</button>
                    <button style={seg(s.salaryWhMode === "custom")} onClick={() => set("salaryWhMode")("custom")}>Custom %</button>
                  </div>
                </div>
              </div>

              {s.salaryWhMode === "ytd" && (
                <div style={{ background: T.blueSoft, border: `1px solid ${T.blue}33`, borderRadius: 9, padding: "10px 12px", marginBottom: 12, fontSize: 12.5, color: T.inkSoft, lineHeight: 1.5 }}>
                  Using <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.blue }}>{fmtPct(m.salaryRate)}</span> — your live YTD effective rate (withheld ÷ earned). Updates automatically when Step 1 changes.
                  {ytdEff == null && " Enter your YTD numbers in Step 1 first."}
                  {" "}Heads-up: if your YTD includes RSU vests withheld at 22%, this blend runs lower than what payroll takes from a pure salary check — the Tax brackets mode is truer to salary.
                </div>
              )}

              {s.salaryWhMode === "bracket" && (
                <div style={{ background: T.blueSoft, border: `1px solid ${T.blue}33`, borderRadius: 9, padding: "10px 12px", marginBottom: 12 }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                    <NumField small label="Annual base salary" prefix="$" value={s.annualSalary} onChange={set("annualSalary")}
                      hint="Full-year rate, used to find where salary sits in the tables." />
                    <div style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.6 }}>
                      Payroll-style estimate on the 2026 {s.w4Step2 ? "single (Step 2)" : STATUS_LABELS[s.status].toLowerCase()} tables:
                      {salaryMath.base > 0 ? (
                        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.ink, marginTop: 4 }}>
                          {fmt$(salaryMath.base)} − {fmt$(salaryMath.ded)} deduction<br />
                          → {fmt$(salaryMath.t)} tax across the brackets<br />
                          ÷ {fmt$(salaryMath.base)} = <span style={{ fontWeight: 700, color: T.blue }}>{fmtPct(m.salaryRate)}</span> effective
                        </div>
                      ) : (
                        <> enter your annual base salary to see the math.</>
                      )}
                      <div style={{ marginTop: 4 }}>
                        This is an <b>average</b> across all brackets — it sits below your marginal rate because the deduction and the 10–24% brackets absorb the first dollars. It's also what payroll really withholds on a default W-4, which assumes this job is the household's only income.
                      </div>
                    </div>
                  </div>
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 12, color: T.inkSoft, cursor: "pointer" }}>
                    <input type="checkbox" checked={s.w4Step2} onChange={(e) => set("w4Step2")(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>My W-4 has Step 2 checked (two jobs / both spouses work) — payroll withholds at the higher single-style schedule.</span>
                  </label>
                </div>
              )}

              {s.salaryWhMode === "custom" && (
                <div style={{ maxWidth: 260, marginBottom: 12 }}>
                  <NumField small label="Custom rate" suffix="%" value={s.salaryWhRate} onChange={set("salaryWhRate")}
                    hint="Best source: federal withheld ÷ gross on one recent regular paycheck." />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                <NumField label="Expected cash bonus" prefix="$" value={s.bonus} onChange={set("bonus")} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 4 }}>
                    Withholding rate on bonus
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={seg(s.bonusWhMode === "flat")} onClick={() => set("bonusWhMode")("flat")}>Flat 22%</button>
                    <button style={seg(s.bonusWhMode === "ytd")} onClick={() => set("bonusWhMode")("ytd")}>Track YTD rate</button>
                    <button style={seg(s.bonusWhMode === "bracket")} onClick={() => set("bonusWhMode")("bracket")}>Tax brackets</button>
                    <button style={seg(s.bonusWhMode === "custom")} onClick={() => set("bonusWhMode")("custom")}>Custom %</button>
                  </div>
                </div>
              </div>

              {s.bonusWhMode === "flat" && (
                <div style={{ marginTop: 10, fontSize: 12, color: T.inkFaint, lineHeight: 1.5 }}>
                  The IRS supplemental rate most employers use for a separate bonus check: 22% flat (37% mandatory on any supplemental wages over $1M — handled automatically).
                </div>
              )}
              {s.bonusWhMode === "ytd" && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: T.inkSoft, background: T.blueSoft, border: `1px solid ${T.blue}33`, borderRadius: 9, padding: "8px 12px", lineHeight: 1.5 }}>
                  Using <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.blue }}>{fmtPct(m.bonusRate)}</span> — your live YTD effective rate. Updates with Step 1.
                </div>
              )}
              {s.bonusWhMode === "bracket" && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: T.inkSoft, background: T.blueSoft, border: `1px solid ${T.blue}33`, borderRadius: 9, padding: "8px 12px", lineHeight: 1.6 }}>
                  Aggregate method: the bonus stacks <b>on top of</b> your salary, so unlike the salary estimate it's withheld at the incremental rate for those dollars —{" "}
                  <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.blue }}>{fmtPct(m.bonusRate)}</span>.
                  {parseNum(s.annualSalary) <= 0 && <> Needs your annual base salary from the salary "Tax brackets" mode above to know where the bonus lands.</>}
                  {parseNum(s.annualSalary) > 0 && parseNum(s.bonus) > 0 && (
                    <div style={{ fontFamily: T.mono, fontSize: 12, color: T.ink, marginTop: 4 }}>
                      tax({fmt$(parseNum(s.annualSalary) + parseNum(s.bonus))}) − tax({fmt$(parseNum(s.annualSalary))}) ÷ {fmt$(parseNum(s.bonus))} = {fmtPct(m.bonusRate)}
                    </div>
                  )}
                </div>
              )}
              {s.bonusWhMode === "custom" && (
                <div style={{ maxWidth: 260, marginTop: 10 }}>
                  <NumField small label="Custom rate" suffix="%" value={s.bonusRate} onChange={set("bonusRate")} />
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 12, fontFamily: T.mono, color: T.ink }}>
                Projected withholding — salary: {fmt$(m.salaryWH)} · bonus: {fmt$(m.bonusWH)}
              </div>
            </Card>

            <Card eyebrow="Step 3" title="Shares already vested this year">
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12, padding: "10px 12px", borderRadius: 9, background: "#F7F9FB", border: `1px solid ${T.line}`, fontSize: 12.5, color: T.inkSoft, cursor: "pointer" }}>
                <input type="checkbox" checked={s.vestedIncluded} onChange={(e) => set("vestedIncluded")(e.target.checked)} style={{ marginTop: 2 }} />
                <span>These vests are <b>already inside my YTD earnings and withholding above</b> (true if you read YTD totals off a paystub — most tech paystubs fold RSU income in). Checking this prevents double-counting.</span>
              </label>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <button style={seg(s.vestedMode === "shares")} onClick={() => set("vestedMode")("shares")}>Shares × avg price</button>
                <button style={seg(s.vestedMode === "total")} onClick={() => set("vestedMode")("total")}>Just a total $</button>
              </div>
              {s.vestedMode === "shares" ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ display: "grid", gap: 12 }}>
                  <NumField label="Shares vested YTD" value={s.vestedShares} onChange={set("vestedShares")} disabled={s.vestedIncluded} />
                  <NumField label="Avg price at vest" prefix="$" value={s.vestedAvgPrice} onChange={set("vestedAvgPrice")} disabled={s.vestedIncluded}
                    hint="Rough average is fine — no need to dig up every vest." />
                  <NumField label="Withholding rate applied" suffix="%" value={s.vestedRate} onChange={set("vestedRate")} disabled={s.vestedIncluded} />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                  <NumField label="Total value of shares vested YTD" prefix="$" value={s.vestedTotal} onChange={set("vestedTotal")} disabled={s.vestedIncluded} />
                  <NumField label="Withholding rate applied" suffix="%" value={s.vestedRate} onChange={set("vestedRate")} disabled={s.vestedIncluded} />
                </div>
              )}
              {!s.vestedIncluded && (
                <div style={{ marginTop: 8, fontSize: 12, fontFamily: T.mono, color: T.ink }}>
                  Adds {fmt$(m.vestedIncome)} income · {fmt$(m.vestedWH)} withheld
                </div>
              )}
            </Card>

            <Card eyebrow="Step 4 · What-if levers" title="Upcoming vests" tint={T.blue}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12, marginBottom: 12 }}>
                <NumField label="Predicted share price" prefix="$" value={s.predictedPrice} onChange={set("predictedPrice")}
                  hint="Your what-if lever. Applies to every vest below unless a row has its own price." />
                <NumField label="RSU withholding rate" suffix="%" value={s.rsuRate} onChange={set("rsuRate")}
                  hint="Default 22% supplemental — often too low at higher incomes, which is where surprise tax bills come from." />
              </div>

              <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.9fr 0.9fr 1fr 34px", gap: 8, padding: "8px 10px", background: "#F5F7F9", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.inkSoft, minWidth: 520 }}>
                  <span>Vest</span><span>Shares</span><span>Price override</span><span style={{ textAlign: "right" }}>Value ($)</span><span />
                </div>
                {m.vestDetails.map((v) => {
                  const overridden = v.dollar !== "";
                  return (
                    <div key={v.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.9fr 0.9fr 1fr 34px", gap: 8, padding: "8px 10px", borderTop: `1px solid ${T.line}`, alignItems: "center", minWidth: 520 }}>
                      <input value={v.label} onChange={(e) => updVest(v.id, "label", e.target.value)}
                        style={{ border: `1px solid ${T.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, background: "#FBFCFD", minWidth: 0 }} />
                      <input value={v.shares} inputMode="decimal" placeholder="0" onChange={(e) => updVest(v.id, "shares", e.target.value)}
                        style={{ border: `1px solid ${T.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: T.mono, background: "#FBFCFD", minWidth: 0, opacity: overridden ? 0.35 : 1 }} />
                      <input value={v.price} inputMode="decimal" placeholder="global" onChange={(e) => updVest(v.id, "price", e.target.value)}
                        style={{ border: `1px solid ${v.price !== "" ? T.blue : T.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: T.mono, background: v.price !== "" ? T.blueSoft : "#FBFCFD", minWidth: 0, opacity: overridden ? 0.35 : 1 }} />
                      <input value={v.dollar} inputMode="decimal" placeholder={v.computed > 0 ? fmt0(v.computed) : "auto"} onChange={(e) => updVest(v.id, "dollar", e.target.value)}
                        title={overridden ? "Direct dollar value — overrides shares × price" : `Auto: shares × price = ${fmt$(v.computed)}. Type to override.`}
                        style={{ border: `1px solid ${overridden ? T.blue : T.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: T.mono, background: overridden ? T.blueSoft : "#FBFCFD", minWidth: 0, textAlign: "right" }} />
                      <button onClick={() => rmVest(v.id)} title="Remove"
                        style={{ border: "none", background: "transparent", color: T.inkFaint, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
                    </div>
                  );
                })}
                <div style={{ padding: "8px 10px", borderTop: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button onClick={addVest} style={{ border: `1px dashed ${T.blue}`, background: "transparent", color: T.blue, borderRadius: 7, padding: "5px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                    + Add vest
                  </button>
                  <span style={{ fontFamily: T.mono, fontSize: 12.5 }}>
                    Total {fmt$(m.upcomingIncome)} · withheld {fmt$(m.upcomingWH)}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 8, fontSize: 11.5, color: T.inkFaint, lineHeight: 1.4 }}>
                The Value column shows shares × price automatically — or type a dollar amount there to set a vest's value directly (turns blue; shares and price are ignored for that row). Clear it to go back to auto.
              </div>
            </Card>

            <Card eyebrow="Step 5" title="Deductions, credits & everything else">
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <button style={seg(s.deductionMode === "standard")} onClick={() => set("deductionMode")("standard")}>
                  Standard deduction ({fmt$(STD_DEDUCTION[s.status])})
                </button>
                <button style={seg(s.deductionMode === "custom")} onClick={() => set("deductionMode")("custom")}>Itemized / custom</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                {s.deductionMode === "custom" && (
                  <NumField label="Total deductions" prefix="$" value={s.customDeduction} onChange={set("customDeduction")} />
                )}
                <NumField label="Other taxable income" prefix="$" value={s.otherIncome} onChange={set("otherIncome")}
                  hint="Spouse's full-year wages/RSUs, interest, dividends, side income — everything else that lands on the joint return." />
                <NumField label="Federal withholding on that income" prefix="$" value={s.otherWithholding} onChange={set("otherWithholding")}
                  hint="Spouse's projected full-year federal withholding + any estimated payments, so their income isn't counted without its withholding." />
                <NumField label="Qualifying children" value={s.kids} onChange={set("kids")}
                  hint={`$${CTC_PER_CHILD.toLocaleString()} child tax credit each; phases out above ${fmt$(CTC_PHASEOUT_START[s.status])} AGI. A baby born anytime in 2026 counts for the full year.`} />
                <NumField label="Other tax adjustments (+/−)" prefix="$" value={s.otherAdj} onChange={set("otherAdj")}
                  hint="Manual catch-all: Additional Medicare tax, NIIT, other credits (enter credits as a negative number)." />
              </div>
            </Card>
          </div>

          {/* ================= RIGHT: RESULTS ================= */}
          <div className="lg:col-span-2" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            <div id="verdict">
              <Card eyebrow="The verdict">
                <GapGauge m={m} />
              </Card>
            </div>

            <Card eyebrow="Your lever" title="Extra withholding per paycheck" tint={T.blue}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ display: "grid", gap: 12 }}>
                <NumField small label="Extra federal withholding per paycheck" prefix="$" value={s.extraPerCheck} onChange={set("extraPerCheck")}
                  hint="The amount you'd put on W-4 line 4(c)." />
                <NumField small label="Paychecks remaining this year" value={s.remainingPaychecks} onChange={set("remainingPaychecks")} />
              </div>
              <div style={{ marginTop: 12, background: "#F7F9FB", border: `1px solid ${T.line}`, borderRadius: 9, padding: "10px 12px", fontSize: 12.5, color: T.inkSoft, lineHeight: 1.6 }}>
                Adds <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.blue }}>{fmt$(m.extraWH)}</span> of withholding
                ({fmt$(m.extraPerCheck)} × {m.paychecks} paychecks) — already reflected in the gauge above.
              </div>
            </Card>

            <Card eyebrow="The math" title="Liability breakdown">
              <LineItem label="Total income" value={fmt$(m.totalIncome)} />
              <LineItem indent label={s.deductionMode === "standard" ? "Standard deduction" : "Deductions"} value={"−" + fmt$(m.deduction)} />
              <LineItem label="Taxable income" value={fmt$(m.taxable)} strong />
              <div style={{ margin: "10px 0 14px" }}>
                <BracketBar taxable={m.taxable} status={s.status} />
              </div>
              <LineItem label="Tax from brackets" value={fmt$(m.bracketTax)} />
              {m.ctc > 0 && <LineItem indent label="Child tax credit" value={"−" + fmt$(m.ctc)} color={T.refund} />}
              {m.otherAdj !== 0 && <LineItem indent label="Other adjustments" value={(m.otherAdj > 0 ? "+" : "") + fmt$(m.otherAdj)} />}
              <LineItem label="Projected liability" value={fmt$(m.liability)} strong />
              <div style={{ height: 10 }} />
              <LineItem label="YTD withheld" value={fmt$(m.ytdWH)} />
              <LineItem indent label={`From remaining salary (@ ${fmtPct(m.salaryRate)})`} value={fmt$(m.salaryWH)} />
              <LineItem indent label={`From bonus (@ ${fmtPct(m.bonusRate)})`} value={fmt$(m.bonusWH)} />
              {m.vestedWH > 0 && <LineItem indent label="From vested shares" value={fmt$(m.vestedWH)} />}
              <LineItem indent label="From upcoming vests" value={fmt$(m.upcomingWH)} />
              {m.otherWH > 0 && <LineItem indent label="Withholding on other income" value={fmt$(m.otherWH)} />}
              {m.extraWH > 0 && <LineItem indent label={`Extra withholding (${fmt$(m.extraPerCheck)} × ${m.paychecks})`} value={fmt$(m.extraWH)} color={T.blue} />}
              <LineItem label="Projected total withheld" value={fmt$(m.withholding)} strong />
              <div style={{ height: 6 }} />
              <LineItem label={m.gap > 0 ? "Balance due" : "Refund"} value={fmt$(Math.abs(m.gap))} strong color={m.gap > 0 ? T.owe : T.refund} />
            </Card>

            <Card eyebrow="Penalty check" title="Safe harbor">
              <NumField small label="Total federal tax on your 2025 return" prefix="$" value={s.priorYearTax} onChange={set("priorYearTax")}
                hint="Form 1040 'total tax' line. Needed for the 110% rule and the tipping point below. (110% applies when prior-year AGI was over $150k; below that, the rule is 100% and this card slightly overstates the requirement.)" />

              {/* Two prongs — auto-checked from your numbers; meeting either one is enough */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { met: meets90, name: "90% rule", need: sh90, desc: "withhold ≥ 90% of your 2026 tax", avail: m.liability > 0 },
                  { met: meets110, name: "110% rule", need: sh110, desc: "withhold ≥ 110% of your 2025 tax", avail: sh110 != null },
                ].map((p) => (
                  <div key={p.name} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", borderRadius: 9, background: p.met ? T.refundSoft : "#F7F9FB", border: `1px solid ${p.met ? T.refund + "44" : T.line}` }}>
                    <input type="checkbox" checked={p.met} readOnly style={{ marginTop: 2, accentColor: T.refund, pointerEvents: "none" }} />
                    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 700, color: p.met ? T.refund : T.ink }}>{p.name}</span>
                      <span style={{ color: T.inkSoft }}> — {p.desc}</span>
                      <div style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft }}>
                        {p.avail ? (
                          <>need {fmt$(p.need)} · have {fmt$(m.withholding)}{!p.met && <span style={{ color: T.owe }}> · short {fmt$(p.need - m.withholding)}</span>}</>
                        ) : (
                          <>enter 2025 tax above</>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: safeHarborOK ? T.refund : T.owe }}>
                {deMinimis && !meets90 && !meets110
                  ? "No penalty — projected balance due is under $1,000"
                  : safeHarborOK ? "Penalty-safe — at least one rule is met" : "Not penalty-safe — neither rule is met"}
              </div>

              {/* Tipping point: which rule is the cheaper target, and how far to the flip */}
              {crossover != null && (
                <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 9, background: T.blueSoft, border: `1px solid ${T.blue}33` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.blue }}>Tipping point</div>
                  <div style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.6, marginTop: 3 }}>
                    The cheaper target flips when your 2026 tax crosses <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.ink }}>{fmt$(crossover)}</span> (2025 tax × 11⁄9).
                    Yours is <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.ink }}>{fmt$(m.liability)}</span> — you're on the <b style={{ color: T.ink }}>{on90Side ? "90% side" : "110% side"}</b>:{" "}
                    {on90Side
                      ? <>90% of this year is the smaller number. Another {fmt$(crossover - m.liability)} of 2026 tax (≈ {fmt$((crossover - m.liability) / (m.margRate || 0.37))} more income at your marginal rate) tips you over, and 110% of last year becomes the cheaper, fixed target.</>
                      : <>your 2026 tax has grown past it, so 110% of last year ({fmt$(sh110)}) is the cheaper target — and it's a fixed number that won't move with your stock-price what-ifs.</>}
                  </div>
                  {/* liability position vs crossover */}
                  <div style={{ position: "relative", height: 10, background: "#fff", border: `1px solid ${T.line}`, borderRadius: 5, marginTop: 8, overflow: "hidden" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, (m.liability / (crossover * 1.5)) * 100)}%`, background: on90Side ? T.refund : T.owe, opacity: 0.55, transition: "width .3s" }} />
                    <div style={{ position: "absolute", left: `${(1 / 1.5) * 100}%`, top: -1, bottom: -1, width: 2, background: T.ink }} title={`Crossover: ${fmt$(crossover)}`} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: T.inkFaint, marginTop: 3, fontFamily: T.mono }}>
                    <span>2026 tax</span><span>flip at {fmt$(crossover)}</span>
                  </div>
                </div>
              )}
            </Card>

            <div style={{ fontSize: 11, color: T.inkFaint, lineHeight: 1.6, padding: "0 4px" }}>
              Uses 2026 federal brackets, standard deductions, and child tax credit from IRS Rev. Proc. 2025-32.
              Ordinary income tax only — capital gains rates, Additional Medicare tax (0.9% over $250k MFJ comp), and NIIT aren't modeled;
              use "Other tax adjustments" to fold those in. A planning tool, not tax advice.
              {savedAt && <span> · Inputs auto-saved {savedAt.toLocaleTimeString()}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* First-run intro (NUX): privacy first, then what it does, then a worked example */}
      {nuxOpen && (() => {
        const chip = (label, val) => (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 10px", background: "#F4F6F9", borderRadius: 8, fontSize: 13 }}>
            <span style={{ color: T.inkSoft }}>{label}</span>
            <span style={{ fontFamily: T.mono, fontWeight: 600, color: T.ink }}>{val}</span>
          </div>
        );
        const perCheck = demoM.gap / 12;
        const steps = [
          {
            title: "Your numbers never leave this device",
            body: (
              <>
                <p style={{ margin: "0 0 10px" }}>Before anything else: <b>everything you type stays on your phone or computer.</b></p>
                <p style={{ margin: "0 0 10px" }}>All calculations run right here in your browser. Your financial numbers are never uploaded or sent anywhere — no server, no analytics, <b>not even Cloudflare</b>, which only checks your email at sign-in and delivers this page.</p>
                <p style={{ margin: 0 }}>To save you retyping, your inputs are kept in this browser's <b>local storage</b> — a small store that lives only on this device, tied to this browser. It is never synced, uploaded, or readable by anyone else, and the <b>Reset</b> button wipes it whenever you like. (Clearing your browser's site data also removes it.)</p>
              </>
            ),
          },
          {
            title: "What this tool does",
            body: (
              <>
                <p style={{ margin: "0 0 10px" }}>Its main job is to tell you whether you're <b>under-paying your federal taxes</b> as the year unfolds — and if so, <b>by how much</b>, and whether it will trigger an <b>IRS underpayment penalty</b>.</p>
                <p style={{ margin: "0 0 10px" }}>You tell it what's happened so far (earnings, tax withheld) and what's still coming (salary, bonus, stock vests). It runs real 2026 federal tax math to project the gap between what you'll owe and what you'll have paid — and checks that gap against the IRS "safe harbor" rules that decide if a penalty applies.</p>
                <p style={{ margin: 0 }}>Under-paying is common with RSUs, which are usually withheld at a flat 22% while your real rate may be far higher. Catching it in July is cheap; discovering it in April isn't.</p>
              </>
            ),
          },
          {
            title: "Example: meet Maya",
            body: (
              <>
                <p style={{ margin: "0 0 10px" }}>Maya's paystub says, so far this year:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {chip("Earned year-to-date", fmt$(260000))}
                  {chip("Federal tax withheld", fmt$(61000))}
                </div>
                <p style={{ margin: "0 0 10px" }}>Still coming before Dec 31:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {chip("Remaining salary", fmt$(160000))}
                  {chip("Cash bonus (withheld at 22%)", fmt$(40000))}
                  {chip("600 shares vesting @ $550 predicted", fmt$(330000))}
                </div>
              </>
            ),
          },
          {
            title: "The verdict — computed live",
            body: (
              <>
                <p style={{ margin: "0 0 10px" }}>The tool runs Maya's numbers through the real 2026 brackets:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {chip("Total income", fmt$(demoM.totalIncome))}
                  {chip("Tax she'll owe (after credits)", fmt$(demoM.liability))}
                  {chip("Tax she'll have paid", fmt$(demoM.withholding))}
                </div>
                <div style={{ padding: "10px 12px", borderRadius: 9, background: demoM.gap > 0 ? T.oweSoft : T.refundSoft, border: `1px solid ${demoM.gap > 0 ? T.owe : T.refund}33`, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, color: T.inkSoft }}>{demoM.gap > 0 ? "Projected balance due at filing" : "Projected refund"}: </span>
                  <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 16, color: demoM.gap > 0 ? T.owe : T.refund }}>{fmt$(Math.abs(demoM.gap))}</span>
                </div>
                <p style={{ margin: 0 }}>Her RSUs withheld at 22% while her real marginal rate is {fmtPct(demoM.margRate, 0)} — that's the whole gap. She's also short of both IRS safe harbors, so on top of the bill this would mean an <b>underpayment penalty</b>. The fix: adding <b>{fmt$(Math.max(0, perCheck))}</b> of extra withholding to each of her 12 remaining paychecks closes it — the tool computes this for you as you type, and its safe-harbor card shows exactly when you're penalty-proof.</p>
              </>
            ),
          },
          {
            title: "Ready to try it?",
            body: (
              <>
                <p style={{ margin: "0 0 10px" }}>Explore with Maya's numbers already filled in (change anything — the verdict updates live), or start with a blank slate and your own paystub.</p>
                <p style={{ margin: 0, fontSize: 12.5, color: T.inkFaint }}>You can replay this intro anytime via <b>How it works</b> at the top, and <b>Reset</b> clears all numbers from this device.</p>
              </>
            ),
          },
        ];
        const st = steps[nuxStep];
        const last = nuxStep === steps.length - 1;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(14,20,30,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
            <div style={{ background: "#fff", borderRadius: 16, width: "min(540px, 100%)", maxHeight: "88vh", overflowY: "auto", padding: "22px 22px 18px", boxShadow: "0 20px 60px rgba(14,20,30,0.35)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: T.blue }}>
                  {nuxStep === 0 ? "Privacy" : `Step ${nuxStep} of ${steps.length - 1}`}
                </div>
                <button onClick={() => finishNux(false)} style={{ border: "none", background: "transparent", color: T.inkFaint, fontSize: 12.5, cursor: "pointer", fontWeight: 600 }}>Skip intro</button>
              </div>
              <h2 style={{ margin: "0 0 10px", fontSize: 19, fontWeight: 800, color: T.ink }}>{st.title}</h2>
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: T.inkSoft }}>{st.body}</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", margin: "16px 0 14px" }}>
                {steps.map((_, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: i === nuxStep ? T.blue : T.line }} />
                ))}
              </div>
              {last ? (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button onClick={() => finishNux(true)} style={{ flex: 1, minWidth: 160, padding: "12px 14px", borderRadius: 10, border: "none", background: T.blue, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    Explore with example
                  </button>
                  <button onClick={() => finishNux(false)} style={{ flex: 1, minWidth: 160, padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.line}`, background: "#fff", color: T.ink, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    Start fresh
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10 }}>
                  {nuxStep > 0 && (
                    <button onClick={() => setNuxStep(nuxStep - 1)} style={{ padding: "12px 16px", borderRadius: 10, border: `1px solid ${T.line}`, background: "#fff", color: T.ink, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                      Back
                    </button>
                  )}
                  <button onClick={() => setNuxStep(nuxStep + 1)} style={{ flex: 1, padding: "12px 16px", borderRadius: 10, border: "none", background: nuxStep === 0 ? T.ink : T.blue, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    {nuxStep === 0 ? "Got it — my data stays with me" : "Next"}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Mobile live-results bar: the verdict follows you while you edit inputs */}
      {isNarrow && (
        <div
          onClick={() => document.getElementById("verdict")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          style={{
            position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50,
            background: T.ink, color: "#fff", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 18px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
            boxShadow: "0 -4px 14px rgba(20,30,43,0.28)",
          }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", opacity: 0.7 }}>
              {Math.abs(m.gap) < 1 ? "On target" : m.gap > 0 ? "Projected balance due" : "Projected refund"}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>tap for full breakdown</div>
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 21, fontWeight: 700, color: Math.abs(m.gap) < 1 ? "#fff" : m.gap > 0 ? "#FF9E88" : "#7FE0BE" }}>
            {fmt$(Math.abs(m.gap))}
          </div>
        </div>
      )}
    </div>
  );
}
