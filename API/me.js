const express = require("express");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

/** GET /me/overview – user + homes + visible rooms + visible devices */

router.get("/me/overview", requireAuth, async (req, res) => {
  const db = await poolPromise;
  const uid = req.user.id;

  try {
    const u = await db
      .request()
      .input("id", sql.Int, uid)
      .query("SELECT id, name, mobile, email FROM Users WHERE id=@id");
    const user = u.recordset[0];
    if (!user) {
      return res.status(404).json({ status: false, message: "user not found" });
    }

    const homes = await db.request().input("u", sql.Int, uid).query(`
      SELECT h.id, h.name, h.timezone, m.role
      FROM HomeMembers m
      JOIN Homes h ON h.id = m.home_id
      WHERE m.user_id=@u
      ORDER BY h.id DESC
    `);

    const overview = [];
    for (const h of homes.recordset) {
      const hid = h.id;
      const role = h.role;

      let roomsQ;
      let devicesQ;

      if (role === "owner" || role === "admin") {
        // 🔹 مانجر: يشوف كل الـ Rooms و Devices
        roomsQ = `
          SELECT id, home_id, name, sort_order, is_private, icon_path
          FROM Rooms
          WHERE home_id=@h
          ORDER BY sort_order, id
        `;

        devicesQ = `
          SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.pin,
                 d.meta, d.is_active, d.icon_path
          FROM Devices d
          WHERE d.home_id=@h
          ORDER BY d.id DESC
        `;
      } else {
        // 🔹 member / guest: يشوف بس الـ Rooms/Devices المعينة ليه
        // Room visible if:
        //  - created_by = user
        //  - OR في HomeRoomAccess
        roomsQ = `
          SELECT r.id, r.home_id, r.name, r.sort_order, r.is_private, r.icon_path
          FROM Rooms r
          WHERE r.home_id=@h
            AND (
              r.created_by=@u
              OR EXISTS (
                SELECT 1
                FROM HomeRoomAccess a
                WHERE a.home_id=@h
                  AND a.user_id=@u
                  AND a.room_id=r.id
              )
            )
          ORDER BY r.sort_order, r.id
        `;

        // Devices يرثوا نفس السياسة عن طريق الـ Room
        devicesQ = `
          SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.pin,
                 d.meta, d.is_active, d.icon_path
          FROM Devices d
          LEFT JOIN Rooms r ON r.id = d.room_id
          WHERE d.home_id=@h
            AND (
              r.created_by=@u
              OR EXISTS (
                SELECT 1
                FROM HomeRoomAccess a
                WHERE a.home_id=@h
                  AND a.user_id=@u
                  AND a.room_id=r.id
              )
            )
          ORDER BY d.id DESC
        `;
      }

      const rooms = await db
        .request()
        .input("h", sql.Int, hid)
        .input("u", sql.Int, uid)
        .query(roomsQ);

      const devices = await db
        .request()
        .input("h", sql.Int, hid)
        .input("u", sql.Int, uid)
        .query(devicesQ);

      overview.push({
        home: { id: hid, name: h.name, timezone: h.timezone, role },
        rooms: rooms.recordset,
        devices: devices.recordset,
      });
    }

    return res.json({
      status: true,
      message: "OK",
      user,
      overview,
    });
  } catch (e) {
    console.error("overview error:", e);
    return res.status(500).json({ status: false, message: "internal error" });
  }
});

module.exports = router;
