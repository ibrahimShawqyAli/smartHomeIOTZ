// middleware/requireAuth.js
const { verifyAccess } = require("../utils/jwt");
module.exports = (req, res, next) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ message: "no token" });
  try {
    req.user = verifyAccess(tok);
    next();
  } catch {
    return res.status(401).json({ message: "invalid token" });
  }
};
