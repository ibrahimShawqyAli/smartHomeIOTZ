const express = require("express");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

/** utils */
async function userRole(db, homeId, userId) {
  const r = await db
    .request()
    .input("h", sql.Int, homeId)
    .input("u", sql.Int, userId)
    .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
  return r.recordset[0]?.role || null;
}
function isManager(role) {
  return role === "owner" || role === "admin";
}

/** Create home (creator becomes owner) */
router.post("/", requireAuth, async (req, res) => {
  const { name, timezone } = req.body || {};
  if (!name) return res.status(400).json({ message: "name required" });

  try {
    const db = await poolPromise;
    const ins = await db
      .request()
      .input("n", sql.NVarChar, name)
      .input("tz", sql.VarChar, timezone || "Africa/Cairo")
      .input("u", sql.Int, req.user.id).query(`
        DECLARE @id INT;
        INSERT INTO Homes(name, timezone, created_by, created_at)
        VALUES(@n, @tz, @u, SYSDATETIMEOFFSET());
        SET @id = SCOPE_IDENTITY();
        INSERT INTO HomeMembers(home_id, user_id, role)
        VALUES(@id, @u, 'owner');
        SELECT @id AS id;
      `);
    res.status(201).json({ id: ins.recordset[0].id });
  } catch (e) {
    console.error("create home error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** List homes I belong to */
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const db = await poolPromise;
    const r = await db.request().input("u", sql.Int, req.user.id).query(`
        SELECT h.id, h.name, h.timezone, m.role
        FROM HomeMembers m
        JOIN Homes h ON h.id = m.home_id
        WHERE m.user_id = @u
        ORDER BY h.id DESC
      `);
    res.json(r.recordset);
  } catch (e) {
    console.error("list homes error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Get one home (only members) */
router.get("/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await poolPromise;
    const role = await userRole(db, homeId, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const r = await db
      .request()
      .input("h", sql.Int, homeId)
      .query(
        "SELECT id, name, timezone, created_by, created_at FROM Homes WHERE id=@h"
      );
    if (!r.recordset[0]) return res.status(404).json({ message: "not found" });
    res.json(r.recordset[0]);
  } catch (e) {
    console.error("get home error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Update home (name/timezone) – admins/owner only */
router.put("/", requireAuth, async (req, res) => {
  //   const homeId = Number(req.params.homeId);
  const { name, timezone, homeId } = req.body || {};
  try {
    const db = await poolPromise;
    const role = await userRole(db, homeId, req.user.id);
    if (!isManager(role))
      return res.status(403).json({ message: "admin/owner only" });

    await db
      .request()
      .input("h", sql.Int, homeId)
      .input("n", sql.NVarChar, name || null)
      .input("tz", sql.VarChar, timezone || null).query(`
        UPDATE Homes
        SET name = COALESCE(@n, name),
            timezone = COALESCE(@tz, timezone)
        WHERE id=@h
      `);
    res.json({ status: true });
  } catch (e) {
    console.error("update home error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Delete home – owner only, must be empty of devices/rooms */
router.delete("/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await poolPromise;
    const role = await userRole(db, homeId, req.user.id);
    if (role !== "owner")
      return res.status(403).json({ message: "owner only" });

    // ensure empty (no devices/rooms)
    const chk = await db.request().input("h", sql.Int, homeId).query(`
      SELECT
        (SELECT COUNT(*) FROM Devices WHERE home_id=@h) AS devices,
        (SELECT COUNT(*) FROM Rooms   WHERE home_id=@h) AS rooms
    `);
    const { devices, rooms } = chk.recordset[0];
    if (devices > 0 || rooms > 0) {
      return res.status(409).json({ message: "home not empty" });
    }

    await db.request().input("h", sql.Int, homeId).query(`
      DELETE FROM HomeMembers WHERE home_id=@h;
      DELETE FROM Homes WHERE id=@h;
    `);
    res.json({ status: true });
  } catch (e) {
    console.error("delete home error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Invite/add member – admins/owner */
router.post("/:homeId/members", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  const { user_id, role } = req.body || {}; // role: admin|member
  if (!user_id || !role)
    return res.status(400).json({ message: "user_id and role required" });

  try {
    const db = await poolPromise;
    const myRole = await userRole(db, homeId, req.user.id);
    if (!isManager(myRole))
      return res.status(403).json({ message: "admin/owner only" });

    await db
      .request()
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, user_id)
      .input("r", sql.VarChar, role).query(`
        IF NOT EXISTS (SELECT 1 FROM HomeMembers WHERE home_id=@h AND user_id=@u)
          INSERT INTO HomeMembers(home_id, user_id, role) VALUES(@h, @u, @r)
        ELSE
          UPDATE HomeMembers SET role=@r WHERE home_id=@h AND user_id=@u
      `);
    res.json({ status: true });
  } catch (e) {
    console.error("add member error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

/** Remove member – admins/owner (cannot remove owner) */
router.delete("/:homeId/members/:userId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  const targetUserId = Number(req.params.userId);
  try {
    const db = await poolPromise;
    const myRole = await userRole(db, homeId, req.user.id);
    if (!isManager(myRole))
      return res.status(403).json({ message: "admin/owner only" });

    const role = await userRole(db, homeId, targetUserId);
    if (role === "owner")
      return res.status(409).json({ message: "cannot remove owner" });

    await db
      .request()
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, targetUserId)
      .query("DELETE FROM HomeMembers WHERE home_id=@h AND user_id=@u");
    res.json({ status: true });
  } catch (e) {
    console.error("remove member error:", e);
    res.status(500).json({ message: "internal error" });
  }
});
// --- List members of a home  ---
// --- List members with attached room ids + names (admin/owner only)
router.get("/:homeId/members", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await poolPromise;

    const my = await db
      .request()
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, req.user.id)
      .query("SELECT role FROM HomeMembers WHERE home_id=@h AND user_id=@u");
    const myRole = my.recordset[0]?.role;
    if (!(myRole === "owner" || myRole === "admin"))
      return res.status(403).json({ message: "admin/owner only" });

    const q = `
      WITH Members AS (
        SELECT m.user_id, m.role, u.email
        FROM HomeMembers m
        JOIN Users u ON u.id = m.user_id
        WHERE m.home_id = @h
      )
      SELECT
        M.user_id,
        M.email,
        M.role,
        -- ids
        (SELECT a.room_id
         FROM HomeRoomAccess a
         WHERE a.home_id=@h AND a.user_id=M.user_id
         ORDER BY a.room_id
         FOR JSON PATH) AS rooms_json,
        -- names
        (SELECT a.room_id AS id, r.name
         FROM HomeRoomAccess a
         JOIN Rooms r ON r.id = a.room_id
         WHERE a.home_id=@h AND a.user_id=M.user_id
         ORDER BY r.sort_order, r.id
         FOR JSON PATH) AS rooms_named_json
      FROM Members M
      ORDER BY CASE M.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, M.user_id;
    `;
    const r = await db.request().input("h", sql.Int, homeId).query(q);

    const out = r.recordset.map((row) => {
      let ids = null,
        named = null;
      try {
        const arr = JSON.parse(row.rooms_json || "[]");
        if (arr.length) ids = arr.map((x) => x.room_id);
      } catch {}
      try {
        const arr = JSON.parse(row.rooms_named_json || "[]");
        if (arr.length) named = arr;
      } catch {}
      return {
        user_id: row.user_id,
        email: row.email,
        role: row.role,
        allowed_room_ids: ids, // null => full-home access
        allowed_rooms: named, // [{id, name}] or null
      };
    });

    res.json(out);
  } catch (e) {
    console.error("list members error:", e);
    res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
