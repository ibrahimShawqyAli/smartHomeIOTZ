// API/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const {
  signAccess,
  signRefresh,
  verifyAccess,
  ttlToMs,
  REFRESH_TTL,
} = require("../utils/jwt");

const router = express.Router();

/* --------------------------------- helpers --------------------------------- */
// API/auth.js

async function getOverview(db, userId) {
  const homes = await db.request().input("u", sql.Int, userId).query(`
    SELECT h.id, h.name, h.timezone, m.role
    FROM HomeMembers m
    JOIN Homes h ON h.id = m.home_id
    WHERE m.user_id=@u
    ORDER BY h.id DESC
  `);

  const out = [];
  for (const h of homes.recordset) {
    const hid = h.id;
    const role = h.role;

    let roomsQ;
    let devicesQ;

    if (role === "owner" || role === "admin") {
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
      .input("u", sql.Int, userId)
      .query(roomsQ);

    const devices = await db
      .request()
      .input("h", sql.Int, hid)
      .input("u", sql.Int, userId)
      .query(devicesQ);

    out.push({
      home: { id: hid, name: h.name, timezone: h.timezone, role },
      rooms: rooms.recordset,
      devices: devices.recordset,
    });
  }

  return out;
}

/* ------------------- POST /auth/register-with-home ------------------- */
/**
 * Body:
 * {
 *   "name": "Ibrahim",
 *   "mobile": "010xxxxxxx",   // unique (nullable is allowed)
 *   "email": "owner@example.com",
 *   "password": "Passw0rd!",
 *   "home": {
 *     "name": "Ambosh Home",
 *     "timezone": "Africa/Cairo",
 *     "address": "Cairo",
 *     "rooms": ["Living Room","Kitchen"]   // optional seed, public rooms
 *   },
 *   "autoLogin": true
 * }
 */
const DEFAULT_ROOM_ICON = "assets/images/public.png";

router.post("/register-with-home", async (req, res) => {
  // ---- 1) Normalize & validate inputs ----
  const raw = req.body || {};
  const home = raw.home || {};

  const name = (raw.name ?? "").trim();
  const mobile = (raw.mobile ?? "").trim();
  const email = (raw.email ?? "").trim().toLowerCase();
  const password = raw.password;

  const homeName = (home.name ?? "").trim();
  const timezone = (home.timezone ?? "").trim();
  const address = home.address ?? null;
  const rooms = Array.isArray(home.rooms) ? home.rooms : [];

  if (!name || !mobile || !email || !password || !homeName) {
    return res.status(400).json({
      status: false,
      code: "REGISTER_VALIDATION",
      message: "name, mobile, email, password, and home.name are required.",
    });
  }

  // Egypt 11-digit local mobile format (adjust if needed)
  const egMobile = /^(01[0-2,5]\d{8})$/;
  if (!egMobile.test(mobile)) {
    return res.status(400).json({
      status: false,
      code: "MOBILE_FORMAT_INVALID",
      message:
        "mobile format is invalid (expected 11-digit local like 010xxxxxxxx).",
    });
  }

  // ---- 2) Start Tx ----
  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // ---- 3) Uniqueness checks (email + mobile) ----
    const chk = await new sql.Request(tx)
      .input("e", sql.VarChar, email)
      .input("m", sql.VarChar, mobile).query(`
        SELECT
          (SELECT COUNT(*) FROM Users WHERE email=@e)  AS email_exists,
          (SELECT COUNT(*) FROM Users WHERE mobile=@m) AS mobile_exists
      `);

    const { email_exists = 0, mobile_exists = 0 } = chk.recordset[0] || {};
    if (email_exists) {
      await tx.rollback();
      return res.status(409).json({
        status: false,
        code: "EMAIL_TAKEN",
        message: "Email already registered",
      });
    }
    if (mobile_exists) {
      await tx.rollback();
      return res.status(409).json({
        status: false,
        code: "MOBILE_TAKEN",
        message: "Mobile already registered",
      });
    }

    // ---- 4) Create user ----
    const hash = await bcrypt.hash(password, 10);
    const userIns = await new sql.Request(tx)
      .input("n", sql.NVarChar, name)
      .input("m", sql.VarChar, mobile)
      .input("e", sql.VarChar, email)
      .input("p", sql.VarChar, hash).query(`
        INSERT INTO Users (name, mobile, email, password_hash, is_active, created_at)
        OUTPUT inserted.id, inserted.name, inserted.mobile, inserted.email
        VALUES (@n, @m, @e, @p, 1, SYSDATETIMEOFFSET())
      `);
    const user = userIns.recordset[0];

    // ---- 5) Create home ----
    const homeIns = await new sql.Request(tx)
      .input("n", sql.NVarChar, homeName)
      .input("tz", sql.VarChar, timezone || "Africa/Cairo")
      .input("a", sql.NVarChar, address)
      .input("u", sql.Int, user.id).query(`
        INSERT INTO Homes (name, timezone, address, created_by, created_at)
        OUTPUT inserted.id
        VALUES (@n, @tz, @a, @u, SYSDATETIMEOFFSET())
      `);
    const homeId = homeIns.recordset[0].id;

    // ---- 6) Owner membership ----
    await new sql.Request(tx)
      .input("h", sql.Int, homeId)
      .input("u", sql.Int, user.id)
      .input("r", sql.VarChar, "owner")
      .query(
        `INSERT INTO HomeMembers(home_id, user_id, role) VALUES(@h, @u, @r)`
      );

    // ---- 7) Optional seed rooms (public), with icon defaults ----
    if (rooms.length) {
      let order = 1;
      for (const r of rooms) {
        // allow both ["Kitchen", ...] and [{ name, icon_path }, ...]
        const roomName =
          typeof r === "object" && r !== null
            ? String(r.name || "").trim()
            : String(r || "").trim();

        if (!roomName) continue;

        const iconPath =
          typeof r === "object" && r !== null && r.icon_path
            ? String(r.icon_path).trim()
            : DEFAULT_ROOM_ICON;

        await new sql.Request(tx)
          .input("h", sql.Int, homeId)
          .input("n", sql.NVarChar, roomName)
          .input("o", sql.Int, order++)
          .input("i", sql.NVarChar, iconPath).query(`
            INSERT INTO Rooms (home_id, name, sort_order, icon_path, created_at)
            VALUES(@h, @n, @o, @i, SYSDATETIMEOFFSET())
          `);
      }
    }

    await tx.commit();

    // ---- 8) Auto-login? issue tokens + store refresh + overview ----
    const autoLogin = raw.autoLogin !== false;
    if (!autoLogin) {
      return res.status(201).json({
        status: true,
        message: "User and home created",
        user: {
          id: user.id,
          name: user.name,
          mobile: user.mobile,
          email: user.email,
        },
        home_id: homeId,
      });
    }

    const access = signAccess({ id: user.id });
    const refresh = signRefresh({ id: user.id });

    await pool
      .request()
      .input("uid", sql.Int, user.id)
      .input("tok", sql.VarChar, refresh)
      .input("exp", sql.DateTime2, new Date(Date.now() + ttlToMs(REFRESH_TTL)))
      .query(
        "INSERT INTO RefreshTokens(user_id, token, expires_at) VALUES(@uid, @tok, @exp)"
      );

    // getOverview must SELECT icon_path for Rooms/Devices so it flows here
    const overview = await (async function getOverview(db, userId) {
      const homes = await db.request().input("u", sql.Int, userId).query(`
        SELECT h.id, h.name, h.timezone, m.role
        FROM HomeMembers m
        JOIN Homes h ON h.id = m.home_id
        WHERE m.user_id=@u
        ORDER BY h.id DESC
      `);

      const out = [];
      for (const h of homes.recordset) {
        const hid = h.id;

        const roomsQ =
          h.role === "owner" || h.role === "admin"
            ? `
            SELECT id, home_id, name, sort_order, is_private, icon_path
            FROM Rooms
            WHERE home_id=@h
            ORDER BY sort_order, id
          `
            : `
            SELECT r.id, r.home_id, r.name, r.sort_order, r.is_private, r.icon_path
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
          `;
        const rooms = await db
          .request()
          .input("h", sql.Int, hid)
          .input("u", sql.Int, userId)
          .query(roomsQ);

        const devicesQ =
          h.role === "owner" || h.role === "admin"
            ? `
            SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.pin, d.meta, d.is_active, d.icon_path
            FROM Devices d
            WHERE d.home_id=@h
            ORDER BY d.id DESC
          `
            : `
            SELECT d.id, d.device_id, d.name, d.type, d.room_id, d.pin, d.meta, d.is_active, d.icon_path
            FROM Devices d
            LEFT JOIN Rooms r ON r.id = d.room_id
            WHERE d.home_id=@h
              AND (
                r.id IS NULL
                OR r.is_private=0
                OR r.created_by=@u
                OR EXISTS (
                  SELECT 1 FROM HomeRoomAccess a
                  WHERE a.home_id=@h AND a.user_id=@u AND a.room_id=r.id
                )
              )
            ORDER BY d.id DESC
          `;

        const devices = await db
          .request()
          .input("h", sql.Int, hid)
          .input("u", sql.Int, userId)
          .query(devicesQ);

        out.push({
          home: { id: hid, name: h.name, timezone: h.timezone, role: h.role },
          rooms: rooms.recordset,
          devices: devices.recordset,
        });
      }
      return out;
    })(pool, user.id);

    return res.status(201).json({
      status: true,
      message: "User and home created",
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
      },
      access,
      refresh,
      overview,
    });
  } catch (err) {
    try {
      await tx.rollback();
    } catch {}
    if (err && (err.number === 2627 || err.number === 2601)) {
      return res.status(409).json({
        status: false,
        code: "DUPLICATE",
        message: "Email or mobile already registered",
      });
    }
    console.error("register-with-home error:", err);
    return res.status(500).json({ status: false, message: "internal error" });
  }
});
/* -------------------------- POST /auth/login -------------------------- */
/** Returns: user, access, refresh, overview */
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  try {
    const db = await poolPromise;
    const r = await db
      .request()
      .input("e", sql.VarChar, email)
      .query(
        "SELECT id, password_hash, is_active, name, mobile, email FROM Users WHERE email=@e"
      );

    const user = r.recordset[0];
    if (!user || user.is_active === 0) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const access = signAccess({ id: user.id });
    const refresh = signRefresh({ id: user.id });

    await db
      .request()
      .input("uid", sql.Int, user.id)
      .input("tok", sql.VarChar, refresh)
      .input("exp", sql.DateTime2, new Date(Date.now() + 30 * 24 * 3600 * 1000))
      .query(
        "INSERT INTO RefreshTokens(user_id,token,expires_at) VALUES(@uid,@tok,@exp)"
      );

    const overview = await getOverview(db, user.id);

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
      },
      access,
      refresh,
      overview,
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

/* ------------------------- POST /auth/refresh ------------------------- */
/** Verifies refresh, binds it to the same user, returns new access token */
router.post("/refresh", async (req, res) => {
  try {
    const { refresh } = req.body || {};
    const payload = verifyRefresh(refresh); // { id, iat, exp }
    const db = await poolPromise;

    const r = await db
      .request()
      .input("tok", sql.VarChar, refresh)
      .input("uid", sql.Int, payload.id)
      .query(
        `
        SELECT id
        FROM RefreshTokens
        WHERE token=@tok
          AND user_id=@uid
          AND expires_at > SYSUTCDATETIME()
      `
      );

    if (!r.recordset[0]) return res.status(401).json({ message: "invalid" });

    const access = signAccess({ id: payload.id });
    return res.json({ access });
  } catch (e) {
    return res.status(401).json({ message: "invalid" });
  }
});
//
/* ----------------------- POST /auth/change-password ----------------------- */
/**
 * Headers:
 *   Authorization: Bearer <access_token>
 * Body:
 * {
 *   "oldPassword": "OldPassw0rd!",
 *   "newPassword": "NewPassw0rd!"
 * }
 */
router.post("/change-password", async (req, res) => {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({
      status: false,
      code: "NO_TOKEN",
      message: "Missing Authorization Bearer token",
    });
  }

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({
      status: false,
      code: "VALIDATION",
      message: "oldPassword and newPassword are required",
    });
  }

 
  if (String(newPassword).length < 6) {
    return res.status(400).json({
      status: false,
      code: "WEAK_PASSWORD",
      message: "newPassword must be at least 8 characters",
    });
  }

  try {
  
    let payload;
    try {
      payload = verifyAccess(m[1]); 
    } catch {
      return res.status(401).json({
        status: false,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      });
    }

    const userId = payload.id;

    const db = await poolPromise;

  
    const r = await db
      .request()
      .input("uid", sql.Int, userId)
      .query("SELECT id, password_hash, is_active FROM Users WHERE id=@uid");

    const user = r.recordset[0];
    if (!user || user.is_active === 0) {
      return res.status(401).json({
        status: false,
        code: "USER_NOT_FOUND",
        message: "User not found or inactive",
      });
    }

    const ok = await bcrypt.compare(
      String(oldPassword),
      user.password_hash || ""
    );
    if (!ok) {
      return res.status(400).json({
        status: false,
        code: "OLD_PASSWORD_WRONG",
        message: "Old password is incorrect",
      });
    }

    // optional: prevent same password
    const same = await bcrypt.compare(
      String(newPassword),
      user.password_hash || ""
    );
    if (same) {
      return res.status(400).json({
        status: false,
        code: "SAME_PASSWORD",
        message: "New password must be different",
      });
    }

    // update hash
    const newHash = await bcrypt.hash(String(newPassword), 10);
    await db
      .request()
      .input("uid", sql.Int, userId)
      .input("h", sql.VarChar, newHash)
      .query("UPDATE Users SET password_hash=@h WHERE id=@uid");

    return res.json({
      status: true,
      message: "Password changed",
    });
  } catch (err) {
    console.error("change-password error:", err);
    return res.status(500).json({
      status: false,
      code: "SERVER_ERROR",
      message: "internal error",
    });
  }
});

module.exports = router;
