const express = require("express");
const { getDb, nextId } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const { userRole } = require("../services/mongoData");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  const { home_id, device_id, scene_id, action, rrule, cron, timezone } =
    req.body;
  if (!!device_id === !!scene_id) {
    return res.status(400).json({ message: "choose device OR scene" });
  }
  if (!rrule && !cron) {
    return res.status(400).json({ message: "rrule or cron required" });
  }

  try {
    const db = await getDb();
    const role = await userRole(home_id, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    await db.collection("schedules").insertOne({
      id: await nextId("schedules"),
      home_id: Number(home_id),
      device_id: device_id ? Number(device_id) : null,
      scene_id: scene_id ? Number(scene_id) : null,
      action: action || null,
      rrule: rrule || null,
      cron: cron || null,
      timezone: timezone || "Africa/Cairo",
      created_by: req.user.id,
      is_active: true,
      created_at: new Date(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("create schedule error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
