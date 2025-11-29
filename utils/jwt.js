const jwt = require("jsonwebtoken");

const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const ACCESS_TTL = process.env.ACCESS_TTL || "365d";
const REFRESH_TTL = process.env.REFRESH_TTL || "300d";

function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}
function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
}
function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET);
}
function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

// "15m" / "2h" / "7d" → ms
function ttlToMs(ttl) {
  const m = String(ttl)
    .trim()
    .match(/^(\d+)\s*([smhd])$/i);
  if (!m) throw new Error(`Invalid TTL format: ${ttl}`);
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mult =
    u === "s" ? 1_000 : u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

module.exports = {
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  ACCESS_TTL,
  REFRESH_TTL,
  ttlToMs,
};
