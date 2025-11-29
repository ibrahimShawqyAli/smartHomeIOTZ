const express = require("express");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

async function userRole(db, homeId, userId) {
  const r = await db
    .request()
    .input("h", sql.Int, homeId)
    .input("u", sql.Int, userId)
    .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  return r.recordset[0]?.role || null;
}
const isManager = (role) => role === "owner" || role === "admin";
const isMember = (role) => !!role;

/** Create room – supports privacy + creator binding */
router.post("/", requireAuth, async (req, res) => {
  const {
    home_id,
    name,
    icon_path,
    sort_order = 0,
    is_private = false,
  } = req.body;

  // Validation
  if (!home_id || !name) {
    return res.status(400).json({
      code: "ROOM_CREATE_VALIDATION",
      message: "home_id and name are required",
    });
  }

  if (!icon_path || !String(icon_path).trim()) {
    return res.status(400).json({
      code: "ROOM_CREATE_VALIDATION",
      message: "icon_path is required",
    });
  }

  try {
    const db = await poolPromise;

    // Ensure caller is owner/admin
    const role = await userRole(db, home_id, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({
        code: "FORBIDDEN",
        message: "Only owner/admin can create rooms in this home.",
      });
    }

    // No duplicate room name inside same home
    const dup = await db
      .request()
      .input("h", sql.Int, home_id)
      .input("n", sql.NVarChar, name)
      .query("SELECT 1 FROM Rooms WHERE home_id=@h AND name=@n");

    if (dup.recordset[0]) {
      return res.status(409).json({
        code: "ROOM_NAME_ALREADY_EXISTS",
        message: "A room with this name already exists in this home.",
      });
    }

    // Insert the room
    const ins = await db
      .request()
      .input("h", sql.Int, home_id)
      .input("n", sql.NVarChar, name)
      .input("s", sql.Int, sort_order)
      .input("p", sql.Bit, is_private ? 1 : 0)
      .input("i", sql.NVarChar, icon_path.trim())
      .input("u", sql.Int, req.user.id).query(`
        INSERT INTO Rooms(home_id, name, sort_order, is_private, created_by, icon_path, created_at)
        OUTPUT inserted.id, inserted.home_id, inserted.name, inserted.sort_order,
               inserted.is_private, inserted.icon_path
        VALUES(@h, @n, @s, @p, @u, @i, SYSDATETIMEOFFSET())
    `);

    const room = ins.recordset[0];

    // Permissions
    if (is_private) {
      // private = only creator has access
      await db
        .request()
        .input("h", sql.Int, home_id)
        .input("u", sql.Int, req.user.id)
        .input("r", sql.Int, room.id).query(`
          DELETE FROM HomeRoomAccess WHERE home_id=@h AND room_id=@r;
          INSERT INTO HomeRoomAccess(home_id, user_id, room_id)
          VALUES(@h, @u, @r);
        `);
    } else {
      // public = remove ACL rows
      await db
        .request()
        .input("h", sql.Int, home_id)
        .input("r", sql.Int, room.id).query(`
          DELETE FROM HomeRoomAccess WHERE home_id=@h AND room_id=@r;
        `);
    }

    return res.status(201).json({
      status: true,
      message: "Room created successfully",
      room,
    });
  } catch (e) {
    if (e && (e.number === 2627 || e.number === 2601)) {
      return res.status(409).json({
        code: "ROOM_NAME_ALREADY_EXISTS",
        message: "A room with this name already exists in this home.",
      });
    }
    console.error("create room error:", e);
    return res.status(500).json({
      code: "ROOM_CREATE_INTERNAL",
      message: "internal error",
    });
  }
});

/** List rooms – visibility aware */
router.get("/home/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await poolPromise;
    const role = await userRole(db, homeId, req.user.id);
    if (!isMember(role))
      return res.status(403).json({ message: "not in home" });

    if (isManager(role)) {
      const r = await db
        .request()
        .input("h", sql.Int, homeId)
        .query(
          "SELECT id, home_id, name, sort_order, is_private FROM Rooms WHERE home_id=@h ORDER BY sort_order, id"
        );
      return res.json(r.recordset);
    }

    const r = await db
      .request()
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, req.user.id).query(`
        SELECT r.id, r.home_id, r.name, r.sort_order, r.is_private
        FROM Rooms r
        WHERE r.home_id=@h
          AND (
            r.is_private=0
            OR r.created_by=@u
            OR EXISTS (
              SELECT 1 FROM HomeRoomAccess a
              WHERE a.home_id=@h AND a.user_id=@u AND a.room_id=r.id
            )
          )
        ORDER BY r.sort_order, r.id
      `);
    return res.json(r.recordset);
  } catch (e) {
    console.error("list rooms error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Update room – allow rename/sort/privacy; keep ACL consistent */
router.put("/:roomId", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const { name, sort_order, is_private, icon_path } = req.body || {};
  try {
    const db = await poolPromise;

    const rr = await db
      .request()
      .input("r", sql.Int, roomId)
      .query("SELECT home_id FROM Rooms WHERE id=@r");
    if (!rr.recordset[0])
      return res.status(404).json({ message: "room not found" });
    const homeId = rr.recordset[0].home_id;

    const role = await userRole(db, homeId, req.user.id);
    if (!isManager(role))
      return res.status(403).json({ message: "admin/owner only" });

    if (name) {
      const dup = await db
        .request()
        .input("h", sql.Int, homeId)
        .input("n", sql.NVarChar, name)
        .input("r", sql.Int, roomId).query(`
          SELECT 1 FROM Rooms WHERE home_id=@h AND name=@n AND id<>@r
        `);
      if (dup.recordset[0])
        return res.status(409).json({
          code: "ROOM_NAME_ALREADY_EXISTS",
          message: "A room with this name already exists in this home.",
        });
    }

    await db
      .request()
      .input("r", sql.Int, roomId)
      .input("n", sql.NVarChar, name || null)
      .input("s", sql.Int, sort_order ?? null)
      .input("p", typeof is_private === "boolean" ? (is_private ? 1 : 0) : null)
      .input(
        "i",
        icon_path != null ? sql.NVarChar : sql.NVarChar,
        icon_path ?? null
      ).query(`
        UPDATE Rooms
        SET name       = COALESCE(@n, name),
            sort_order = COALESCE(@s, sort_order),
            is_private = COALESCE(@p, is_private),
            icon_path  = COALESCE(@i, icon_path)
        WHERE id=@r
      `);

    if (typeof is_private === "boolean") {
      const meta = await db
        .request()
        .input("r", sql.Int, roomId)
        .query("SELECT home_id, created_by FROM Rooms WHERE id=@r");
      const { home_id, created_by } = meta.recordset[0];

      if (is_private) {
        await db
          .request()
          .input("h", sql.Int, home_id)
          .input("r", sql.Int, roomId)
          .query("DELETE FROM HomeRoomAccess WHERE home_id=@h AND room_id=@r");
        if (created_by) {
          await db
            .request()
            .input("h", sql.Int, home_id)
            .input("u", sql.Int, created_by)
            .input("r", sql.Int, roomId)
            .query(
              "INSERT INTO HomeRoomAccess(home_id, user_id, room_id) VALUES(@h, @u, @r)"
            );
        }
      } else {
        await db
          .request()
          .input("h", sql.Int, home_id)
          .input("r", sql.Int, roomId)
          .query("DELETE FROM HomeRoomAccess WHERE home_id=@h AND room_id=@r");
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("update room error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Delete room – admin/owner (must be empty); clears ACL */
router.delete("/:roomId", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  try {
    const db = await poolPromise;
    const rr = await db
      .request()
      .input("r", sql.Int, roomId)
      .query("SELECT home_id FROM Rooms WHERE id=@r");
    if (!rr.recordset[0])
      return res.status(404).json({ message: "room not found" });
    const homeId = rr.recordset[0].home_id;

    const role = await userRole(db, homeId, req.user.id);
    if (!isManager(role))
      return res.status(403).json({ message: "admin/owner only" });

    const hasDevices = await db
      .request()
      .input("r", sql.Int, roomId)
      .query("SELECT COUNT(*) AS c FROM Devices WHERE room_id=@r");
    if (hasDevices.recordset[0].c > 0)
      return res.status(409).json({ message: "room not empty (has devices)" });

    await db
      .request()
      .input("h", sql.Int, homeId)
      .input("r", sql.Int, roomId)
      .query("DELETE FROM HomeRoomAccess WHERE home_id=@h AND room_id=@r");

    await db
      .request()
      .input("r", sql.Int, roomId)
      .query("DELETE FROM Rooms WHERE id=@r");

    res.json({ ok: true });
  } catch (e) {
    console.error("delete room error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Move device into room – admin/owner */
router.post("/:roomId/move-device", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const { device_id } = req.body || {};
  if (!device_id)
    return res
      .status(400)
      .json({ message: "device_id required (internal PK)" });

  try {
    const db = await poolPromise;

    const rr = await db
      .request()
      .input("r", sql.Int, roomId)
      .query("SELECT home_id FROM Rooms WHERE id=@r");
    if (!rr.recordset[0])
      return res.status(404).json({ message: "room not found" });
    const homeId = rr.recordset[0].home_id;

    const role = await userRole(db, homeId, req.user.id);
    if (!isManager(role))
      return res.status(403).json({ message: "admin/owner only" });

    const dr = await db
      .request()
      .input("d", sql.Int, device_id)
      .query("SELECT id, home_id FROM Devices WHERE id=@d");
    if (!dr.recordset[0])
      return res.status(404).json({ message: "device not found" });
    if (dr.recordset[0].home_id !== homeId)
      return res.status(409).json({ message: "device not in this home" });

    await db
      .request()
      .input("d", sql.Int, device_id)
      .input("r", sql.Int, roomId)
      .query("UPDATE Devices SET room_id=@r WHERE id=@d");

    res.json({ ok: true });
  } catch (e) {
    console.error("move device error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
