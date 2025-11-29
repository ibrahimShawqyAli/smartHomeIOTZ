// API/members.js
const express = require("express");
const bcrypt = require("bcryptjs");
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
function isManager(role) {
  return role === "owner" || role === "admin";
}

/**
 * POST /homes/:homeId/invite-register
 * Body:
 * {
 *   "email": "member@example.com",
 *   "password": "Passw0rd!",      // required when creating a new user, ignored if user exists
 *   "role": "member",             // "admin" | "member" | "guest"
 *   "allowed_room_ids": [1,2,3]   // optional: per-room ACL; omitting means full-home access
 * }
 */
router.post("/:homeId/", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);

  // نستقبل البيانات من البودي
  const {
    email,
    password,
    role = "member",
    allowed_room_ids,
    name,
    mobile,
  } = req.body || {};

  if (!email || !role) {
    return res.status(400).json({
      status: false,
      message: "email and role are required",
    });
  }

  const db = await poolPromise;

  // caller must be admin/owner on this home
  const callerRole = await userRole(db, homeId, req.user.id);
  if (!isManager(callerRole)) {
    return res.status(403).json({
      status: false,
      message: "admin/owner only",
    });
  }

  const tx = new sql.Transaction(db);
  try {
    await tx.begin();

    // ---------- find or create user ----------
    const find = await new sql.Request(tx)
      .input("e", sql.VarChar, email)
      .query("SELECT id FROM Users WHERE email=@e");

    let userId;
    if (find.recordset[0]) {
      // user موجود بالفعل → ممكن نعمل تحديث اختياري لـ name/mobile لو مبعوتين
      userId = find.recordset[0].id;

      const safeName = (name || "").trim();
      const safeMobile = (mobile || "").trim();

      if (safeName || safeMobile) {
        await new sql.Request(tx)
          .input("id", sql.Int, userId)
          .input("n", sql.NVarChar, safeName || null)
          .input("m", sql.VarChar, safeMobile || null).query(`
            UPDATE Users
               SET name   = COALESCE(@n, name),
                   mobile = COALESCE(@m, mobile)
             WHERE id=@id
          `);
      }
    } else {
      // لازم باسوورد لإنشاء يوزر جديد
      if (!password) {
        await tx.rollback();
        return res.status(400).json({
          status: false,
          message: "password required to create a new user",
        });
      }

      const hash = await bcrypt.hash(password, 10);

      const safeName =
        (name || "").trim() ||
        (email && email.includes("@") ? email.split("@")[0] : "Member");
      const safeMobile = (mobile || "").trim() || null;

      const ins = await new sql.Request(tx)
        .input("n", sql.NVarChar, safeName)
        .input("e", sql.VarChar, email)
        .input("m", sql.VarChar, safeMobile)
        .input("p", sql.VarChar, hash).query(`
          INSERT INTO Users(name, email, mobile, password_hash, is_active, created_at)
          OUTPUT inserted.id
          VALUES(@n, @e, @m, @p, 1, SYSDATETIMEOFFSET())
        `);

      userId = ins.recordset[0].id;
    }

    // ---------- upsert home membership ----------
    await new sql.Request(tx)
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, userId)
      .input("r", sql.VarChar, role).query(`
        MERGE HomeMembers AS t
        USING (SELECT @h AS home_id, @u AS user_id) s
        ON (t.home_id=s.home_id AND t.user_id=s.user_id)
        WHEN MATCHED THEN UPDATE SET role=@r
        WHEN NOT MATCHED THEN INSERT(home_id, user_id, role) VALUES(@h, @u, @r);
      `);

    // ---------- optional per-room ACL ----------
    if (Array.isArray(allowed_room_ids)) {
      if (allowed_room_ids.length) {
        // تأكيد إن كل الغرف من نفس الـ home
        const vals = allowed_room_ids.map((_, i) => `@r${i}`).join(",");
        const reqV = new sql.Request(tx).input("h", sql.Int, homeId);
        allowed_room_ids.forEach((rid, i) =>
          reqV.input(`r${i}`, sql.Int, Number(rid))
        );

        const check = await reqV.query(`
          SELECT COUNT(*) AS c
          FROM Rooms
          WHERE home_id=@h AND id IN (${vals})
        `);

        if (check.recordset[0].c !== allowed_room_ids.length) {
          await tx.rollback();
          return res.status(400).json({
            status: false,
            message: "one or more room_ids are invalid for this home",
          });
        }
      }

      // نمسح الـ ACL القديم ونضيف الجديد
      await new sql.Request(tx)
        .input("h", sql.Int, homeId)
        .input("u", sql.Int, userId)
        .query("DELETE FROM HomeRoomAccess WHERE home_id=@h AND user_id=@u");

      if (allowed_room_ids.length) {
        for (const rid of allowed_room_ids) {
          await new sql.Request(tx)
            .input("h", sql.Int, homeId)
            .input("u", sql.Int, userId)
            .input("r", sql.Int, Number(rid))
            .query(
              "INSERT INTO HomeRoomAccess(home_id, user_id, room_id) VALUES(@h,@u,@r)"
            );
        }
      }
    }

    await tx.commit();
    return res.status(201).json({
      status: true,
      message: "member added/updated successfully",
      user_id: userId,
      home_id: homeId,
      role,
      allowed_room_ids: Array.isArray(allowed_room_ids)
        ? allowed_room_ids
        : null,
    });
  } catch (err) {
    try {
      await tx.rollback();
    } catch {}
    console.error("invite-register error:", err);
    return res.status(500).json({
      status: false,
      message: "internal error",
    });
  }
});

router.get("/:homeId/members", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isFinite(homeId) || homeId <= 0) {
    return res.status(400).json({
      status: false,
      message: "invalid homeId",
    });
  }

  try {
    const db = await poolPromise;

    const callerRole = await userRole(db, homeId, req.user.id);
    if (!isManager(callerRole)) {
      return res.status(403).json({
        status: false,
        message: "Only owner/admin can view home members.",
      });
    }

    const membersRes = await db.request().input("h", sql.Int, homeId).query(`
        SELECT
          m.user_id,
          u.name,
          u.email,
          u.mobile,
          m.role
        FROM HomeMembers m
        JOIN Users u ON u.id = m.user_id
        WHERE m.home_id = @h
        ORDER BY
          CASE m.role
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            WHEN 'member' THEN 2
            ELSE 3
          END,
          u.name
      `);

    const members = [];

    for (const row of membersRes.recordset) {
      const userId = row.user_id;

      const aclRes = await db
        .request()
        .input("h", sql.Int, homeId)
        .input("u", sql.Int, userId).query(`
          SELECT r.id, r.name
          FROM HomeRoomAccess a
          JOIN Rooms r ON r.id = a.room_id
          WHERE a.home_id = @h AND a.user_id = @u
          ORDER BY r.sort_order, r.id
        `);

      members.push({
        user_id: userId,
        name: row.name,
        email: row.email,
        mobile: row.mobile,
        role: row.role,
        allowed_rooms: aclRes.recordset.map((r) => ({
          id: r.id,
          name: r.name,
        })),
      });
    }

    return res.status(200).json({
      status: true,
      message: "Members fetched successfully",
      home_id: homeId,
      members,
    });
  } catch (err) {
    console.error("list members error:", err);
    return res.status(500).json({
      status: false,
      message: "internal error",
    });
  }
});
module.exports = router;
