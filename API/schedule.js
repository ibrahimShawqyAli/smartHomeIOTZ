const express = require("express");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

// POST /schedules  body: { home_id, device_id | scene_id, action, rrule | cron, timezone }
router.post("/", requireAuth, async (req, res) => {
  const { home_id, device_id, scene_id, action, rrule, cron, timezone } =
    req.body;
  if (!!device_id === !!scene_id)
    return res.status(400).json({ message: "choose device OR scene" });
  if (!rrule && !cron)
    return res.status(400).json({ message: "rrule or cron required" });

  const db = await poolPromise;

  // must be member of the home
  const m = await db
    .request()
    .input("h", sql.Int, home_id)
    .input("u", sql.Int, req.user.id)
    .query("SELECT 1 FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  if (!m.recordset[0]) return res.status(403).json({ message: "not in home" });

  await db
    .request()
    .input("h", sql.Int, home_id)
    .input("d", sql.Int, device_id || null)
    .input("s", sql.Int, scene_id || null)
    .input("a", sql.NVarChar, action || null)
    .input("r", sql.VarChar, rrule || null)
    .input("c", sql.VarChar, cron || null)
    .input("tz", sql.VarChar, timezone || "Africa/Cairo")
    .input("u", sql.Int, req.user.id).query(`
      INSERT INTO Schedules(home_id, device_id, scene_id, action, rrule, cron, timezone, created_by)
      VALUES(@h,@d,@s,@a,@r,@c,@tz,@u)
    `);

  res.json({ ok: true });
});

module.exports = router;
