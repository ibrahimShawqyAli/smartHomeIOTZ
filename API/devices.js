const express = require("express");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const requireAuth = require("../middleware/requireAuth");
const { sendControlToDevice } = require("../services/sender");

const router = express.Router();

/** Claim device (unchanged semantics) */
router.post("/claim", requireAuth, async (req, res) => {
  const { device_id, device_secret, home_id, name, icon_path } = req.body;
  const db = await poolPromise;

  const m = await db
    .request()
    .input("h", sql.Int, home_id)
    .input("u", sql.Int, req.user.id)
    .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  if (!m.recordset[0]) return res.status(403).json({ message: "not in home" });

  const r = await db
    .request()
    .input("d", sql.VarChar, device_id)
    .query("SELECT id, device_secret, home_id FROM Devices WHERE device_id=@d");
  const row = r.recordset[0];
  if (!row)
    return res.status(404).json({ message: "device not connected yet" });
  if (row.home_id && row.home_id !== home_id)
    return res.status(409).json({ message: "device already claimed" });
  if (row.device_secret !== device_secret)
    return res.status(403).json({ message: "secret mismatch" });

  await db
    .request()
    .input("id", sql.Int, row.id)
    .input("h", sql.Int, home_id)
    .input("n", sql.VarChar, name || device_id)
    .input("i", sql.NVarChar, icon_path || "assets/images/lights.png")
    .query(
      "  UPDATE Devices SET home_id=@h, name=@n,  icon_path=@i,  meta=JSON_MODIFY(COALESCE(meta,'{}'), '$.status','claimed')  WHERE id=@id"
    );

  res.json({ ok: true, devicePk: row.id });
});

/** List devices – visibility inherits room privacy */
router.get("/home/:homeId", requireAuth, async (req, res) => {
  const hid = parseInt(req.params.homeId, 10);
  const db = await poolPromise;

  const m = await db
    .request()
    .input("h", sql.Int, hid)
    .input("u", sql.Int, req.user.id)
    .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  const role = m.recordset[0]?.role;
  if (!role) return res.status(403).json({ message: "not in home" });

  if (role === "owner" || role === "admin") {
    const r = await db.request().input("h", sql.Int, hid).query(`
      SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.meta, d.is_active, r.is_private
      FROM Devices d
      LEFT JOIN Rooms r ON r.id = d.room_id
      WHERE d.home_id=@h
      ORDER BY d.id DESC
    `);
    return res.json(r.recordset);
  }

  const r = await db
    .request()
    .input("h", sql.Int, hid)
    .input("u", sql.Int, req.user.id).query(`
    SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.meta, d.is_active
    FROM Devices d
    LEFT JOIN Rooms r ON r.id = d.room_id
    WHERE d.home_id=@h
      AND (
        r.id IS NULL              -- no room = public
        OR r.is_private=0         -- public room
        OR r.created_by=@u        -- private but I'm creator
        OR EXISTS (SELECT 1 FROM HomeRoomAccess a
                   WHERE a.home_id=@h AND a.user_id=@u AND a.room_id=r.id)
      )
    ORDER BY d.id DESC
  `);
  res.json(r.recordset);
});

/** Control device – enforce room privacy for non-managers */
router.post("/:devicePk/control", requireAuth, async (req, res) => {
  const devicePk = Number(req.params.devicePk);
  const payload = req.body;

  const db = await poolPromise;
  const dev = await db
    .request()
    .input("id", sql.Int, devicePk)
    .query("SELECT home_id, room_id FROM Devices WHERE id=@id");
  if (!dev.recordset[0])
    return res.status(404).json({ message: "device not found" });
  const { home_id: hid, room_id } = dev.recordset[0];

  const m = await db
    .request()
    .input("h", sql.Int, hid)
    .input("u", sql.Int, req.user.id)
    .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  const role = m.recordset[0]?.role;
  if (!role) return res.status(403).json({ message: "not in home" });

  if (!(role === "owner" || role === "admin")) {
    if (room_id) {
      const allowed = await db
        .request()
        .input("h", sql.Int, hid)
        .input("u", sql.Int, req.user.id)
        .input("r", sql.Int, room_id).query(`
          SELECT 1
          FROM Rooms r
          WHERE r.id=@r AND r.home_id=@h
            AND (
              r.is_private=0
              OR r.created_by=@u
              OR EXISTS (SELECT 1 FROM HomeRoomAccess a
                         WHERE a.home_id=@h AND a.user_id=@u AND a.room_id=@r)
            )
        `);
      if (!allowed.recordset[0])
        return res
          .status(403)
          .json({ message: "no permission for this room/device" });
    }
  }

  await sendControlToDevice({ devicePk, payload, issuedBy: req.user.id });
  res.json({ status: true });
});

module.exports = router;
