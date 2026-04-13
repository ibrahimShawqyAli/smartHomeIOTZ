const { listActiveSchedules } = require("../services/schedules");
const { sendControlToDevice } = require("../services/sender");

const POLL_MS = 15_000;

function nowUtc() {
  return new Date();
}

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
    : null;

  return { freq, byHour, byMinute, byDay };
}

const JS2RR = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

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
    const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return new Date();
    const [, mm, dd, yyyy, HH, MM, SS] = m;
    return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`);
  } catch {
    return new Date();
  }
}

function isDueRRule(rrule, tz) {
  const r = parseRRule(rrule);
  if (!r) return false;

  const t = getNowInTz(tz || "UTC");
  const hour = t.getHours();
  const minute = t.getMinutes();
  const day = JS2RR[t.getDay()];

  if (r.byHour == null || r.byMinute == null) return false;
  if (r.freq === "WEEKLY" && r.byDay && !r.byDay.includes(day)) return false;

  return hour === r.byHour && minute === r.byMinute && t.getSeconds() * 1000 < POLL_MS;
}

function isDueCron(cron, tz) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minP, hourP, domP, monP, dowP] = parts;

  const t = getNowInTz(tz || "UTC");
  const m = t.getMinutes();
  const h = t.getHours();
  const dow = t.getDay();
  const mon = t.getMonth() + 1;
  const dom = t.getDate();
  const inWindow = t.getSeconds() * 1000 < POLL_MS;

  const match = (pat, val) => {
    if (pat === "*") return true;
    if (pat.startsWith("*/")) {
      const step = Number(pat.slice(2));
      return step > 0 && val % step === 0;
    }
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
    match(hourP, h) &&
    match(domP, dom) &&
    match(monP, mon) &&
    match(dowP, dow);

  return ok && inWindow;
}

async function checkAndTrigger() {
  try {
    const schedules = await listActiveSchedules();
    const due = [];

    for (const row of schedules) {
      const tz = row.timezone || "UTC";
      let fire = false;

      if (row.cron) {
        fire = isDueCron(row.cron, tz);
      } else if (row.rrule) {
        fire = isDueRRule(row.rrule, tz);
      }

      if (fire) due.push(row);
    }

    for (const schedule of due) {
      if (!schedule.device_id) continue;

      let payload;
      try {
        payload = JSON.parse(schedule.action);
      } catch {
        payload = null;
      }

      if (payload && typeof payload === "object") {
        await sendControlToDevice({
          devicePk: schedule.device_id,
          payload,
          issuedBy: null,
        });
        console.log(
          `Schedule fired id=${schedule.id} to device ${schedule.device_id}`
        );
      }
    }
  } catch (e) {
    console.error("schedule poll error:", e);
  }
}

let timer = null;
function startSchedulePolling() {
  if (timer) clearInterval(timer);
  console.log("Schedule poller started (", POLL_MS, "ms )");
  timer = setInterval(checkAndTrigger, POLL_MS);
}

module.exports = { startSchedulePolling };
