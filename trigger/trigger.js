const { sql, poolPromise } = require("../SQL/sqlSetup");
const { sendControlToDevice } = require("../services/sender");

// poll every 15s; fire anything due within this window
const POLL_MS = 15_000;

// helpers
function nowUtc() {
  return new Date();
}

// very small RRULE parser supporting FREQ=DAILY|WEEKLY, BYHOUR, BYMINUTE, BYDAY
function parseRRule(rrule) {
  const parts = Object.fromEntries(
    rrule.split(";").map((kv) => {
      const [k, v] = kv.split("=");
      return [k.toUpperCase(), v];
    })
  );
  const freq = (parts.FREQ || "").toUpperCase();
  if (!["DAILY", "WEEKLY"].includes(freq)) return null;

  const byHour = parts.BYHOUR != null ? Number(parts.BYHOUR) : null;
  const byMinute = parts.BYMINUTE != null ? Number(parts.BYMINUTE) : null;
  const byDay = parts.BYDAY
    ? parts.BYDAY.split(",").map((s) => s.toUpperCase())
    : null; // e.g. MO,TU

  return { freq, byHour, byMinute, byDay };
}

// map JS day (0=Sun) to RRULE 2-letter
const JS2RR = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// naive tz shift using Intl (enough for minute-level checks)
function getNowInTz(tz) {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(nowUtc());
    // s like "10/12/2025, 21:02:05" on en-US, but we forced 2-digit; parse robustly:
    const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return new Date();
    const [, mm, dd, yyyy, HH, MM, SS] = m;
    return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`);
  } catch {
    return new Date();
  }
}

// is a schedule due in this poll window?
function isDueRRule(rrule, tz) {
  const r = parseRRule(rrule);
  if (!r) return false;

  const t = getNowInTz(tz || "UTC");
  const hour = t.getHours();
  const minute = t.getMinutes();
  const day = JS2RR[t.getDay()];

  if (r.byHour == null || r.byMinute == null) return false;
  if (r.freq === "WEEKLY" && r.byDay && !r.byDay.includes(day)) return false;

  // fire once when we pass the exact minute inside this poll window
  const seconds = t.getSeconds() * 1000;
  const offsetMs = seconds; // seconds since minute start
  const withinWindow = offsetMs < POLL_MS; // first ~15s of the target minute
  return hour === r.byHour && minute === r.byMinute && withinWindow;
}

function isDueCron(cron, tz) {
  // Lightweight check via system clock; dependency-free minute matching
  // Supports patterns like "*/5 * * * *" or "2 21 * * *"
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minP, hourP, domP, monP, dowP] = parts;

  const t = getNowInTz(tz || "UTC");
  const m = t.getMinutes();
  const h = t.getHours();
  const dow = t.getDay(); // 0=Sun
  const mon = t.getMonth() + 1;
  const dom = t.getDate();

  const inWindow = t.getSeconds() * 1000 < POLL_MS;

  const match = (pat, val, baseMin = 0, baseMax = 59) => {
    if (pat === "*") return true;
    if (pat.startsWith("*/")) {
      const step = Number(pat.slice(2));
      return step > 0 && val % step === 0;
    }
    // list or single
    return pat.split(",").some((tok) => {
      if (tok.includes("-")) {
        const [a, b] = tok.split("-").map(Number);
        return val >= a && val <= b;
      }
      return Number(tok) === val;
    });
  };

  const ok =
    match(minP, m) &&
    match(hourP, h, 0, 23) &&
    match(domP, dom, 1, 31) &&
    match(monP, mon, 1, 12) &&
    match(dowP, dow, 0, 6);

  return ok && inWindow;
}

async function checkAndTrigger() {
  try {
    const db = await poolPromise;

    // pull active schedules
    const r = await db.request().query(`
      SELECT id, home_id, device_id, scene_id, action, rrule, cron, timezone, is_active
      FROM Schedules
      WHERE is_active = 1
    `);

    const due = [];
    for (const row of r.recordset) {
      const tz = row.timezone || "UTC";
      let fire = false;

      if (row.cron) {
        fire = isDueCron(row.cron, tz);
      } else if (row.rrule) {
        fire = isDueRRule(row.rrule, tz);
      }

      if (fire) due.push(row);
    }

    for (const s of due) {
      // device schedule only (scenes omitted here)
      if (s.device_id) {
        let payload;
        try {
          payload = JSON.parse(s.action);
        } catch {
          payload = null;
        }
        if (payload && typeof payload === "object") {
          await sendControlToDevice({
            devicePk: s.device_id,
            payload,
            issuedBy: null, // system
          });
          console.log(
            `🕒 Schedule fired id=${s.id} → device ${s.device_id} payload=${s.action}`
          );
        }
      }
    }
  } catch (e) {
    console.error("schedule poll error:", e);
  }
}

let timer = null;
function startSchedulePolling() {
  if (timer) clearInterval(timer);
  console.log("📆 Schedule poller started (", POLL_MS, "ms )");
  timer = setInterval(checkAndTrigger, POLL_MS);
}

module.exports = { startSchedulePolling };
