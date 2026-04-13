const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb, nextId } = require("../DB/mongo");
const {
  duplicateKey,
  getOverview,
} = require("../services/mongoData");
const {
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  ttlToMs,
  REFRESH_TTL,
} = require("../utils/jwt");

const router = express.Router();
const DEFAULT_ROOM_ICON = "assets/images/public.png";

router.post("/register-with-home", async (req, res) => {
  const raw = req.body || {};
  const home = raw.home || {};

  const name = (raw.name ?? "").trim();
  const mobile = (raw.mobile ?? "").trim();
  const email = (raw.email ?? "").trim().toLowerCase();
  const password = raw.password;

  const homeName = (home.name ?? "").trim();
  const timezone = (home.timezone ?? "").trim() || "Africa/Cairo";
  const address = home.address ?? null;
  const rooms = Array.isArray(home.rooms) ? home.rooms : [];
  const seedRooms = [];
  const seenSeedRooms = new Set();

  if (!name || !mobile || !email || !password || !homeName) {
    return res.status(400).json({
      status: false,
      code: "REGISTER_VALIDATION",
      message: "name, mobile, email, password, and home.name are required.",
    });
  }

  const egMobile = /^(01[0-2,5]\d{8})$/;
  if (!egMobile.test(mobile)) {
    return res.status(400).json({
      status: false,
      code: "MOBILE_FORMAT_INVALID",
      message:
        "mobile format is invalid (expected 11-digit local like 010xxxxxxxx).",
    });
  }

  for (const roomInput of rooms) {
    const roomName =
      typeof roomInput === "object" && roomInput !== null
        ? String(roomInput.name || "").trim()
        : String(roomInput || "").trim();
    if (!roomName) continue;

    const roomKey = roomName.toLowerCase();
    if (seenSeedRooms.has(roomKey)) continue;
    seenSeedRooms.add(roomKey);

    seedRooms.push({
      name: roomName,
      icon_path:
        typeof roomInput === "object" && roomInput !== null && roomInput.icon_path
          ? String(roomInput.icon_path).trim()
          : DEFAULT_ROOM_ICON,
    });
  }

  try {
    const db = await getDb();
    const users = db.collection("users");

    if (await users.findOne({ email })) {
      return res.status(409).json({
        status: false,
        code: "EMAIL_TAKEN",
        message: "Email already registered",
      });
    }

    if (await users.findOne({ mobile })) {
      return res.status(409).json({
        status: false,
        code: "MOBILE_TAKEN",
        message: "Mobile already registered",
      });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: await nextId("users"),
      name,
      mobile,
      email,
      password_hash: hash,
      is_active: true,
      created_at: new Date(),
    };
    await users.insertOne(user);

    const homeDoc = {
      id: await nextId("homes"),
      name: homeName,
      timezone,
      address,
      created_by: user.id,
      created_at: new Date(),
    };
    await db.collection("homes").insertOne(homeDoc);

    await db.collection("homeMembers").insertOne({
      home_id: homeDoc.id,
      user_id: user.id,
      role: "owner",
    });

    let order = 1;
    for (const roomInput of seedRooms) {
      await db.collection("rooms").insertOne({
        id: await nextId("rooms"),
        home_id: homeDoc.id,
        name: roomInput.name,
        sort_order: order++,
        is_private: false,
        icon_path: roomInput.icon_path,
        created_by: user.id,
        created_at: new Date(),
      });
    }

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
        home_id: homeDoc.id,
      });
    }

    const access = signAccess({ id: user.id });
    const refresh = signRefresh({ id: user.id });

    await db.collection("refreshTokens").insertOne({
      id: await nextId("refreshTokens"),
      user_id: user.id,
      token: refresh,
      expires_at: new Date(Date.now() + ttlToMs(REFRESH_TTL)),
      created_at: new Date(),
    });

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
      overview: await getOverview(user.id),
    });
  } catch (err) {
    if (duplicateKey(err)) {
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

router.post("/login", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const { password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  try {
    const db = await getDb();
    const user = await db.collection("users").findOne(
      { email },
      {
        projection: {
          _id: 0,
          id: 1,
          password_hash: 1,
          is_active: 1,
          name: 1,
          mobile: 1,
          email: 1,
        },
      }
    );

    if (!user || user.is_active === false) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const access = signAccess({ id: user.id });
    const refresh = signRefresh({ id: user.id });

    await db.collection("refreshTokens").insertOne({
      id: await nextId("refreshTokens"),
      user_id: user.id,
      token: refresh,
      expires_at: new Date(Date.now() + ttlToMs(REFRESH_TTL)),
      created_at: new Date(),
    });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
      },
      access,
      refresh,
      overview: await getOverview(user.id),
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { refresh } = req.body || {};
    const payload = verifyRefresh(refresh);
    const db = await getDb();

    const token = await db.collection("refreshTokens").findOne({
      token: refresh,
      user_id: payload.id,
      expires_at: { $gt: new Date() },
    });

    if (!token) return res.status(401).json({ message: "invalid" });

    const access = signAccess({ id: payload.id });
    return res.json({ access });
  } catch {
    return res.status(401).json({ message: "invalid" });
  }
});

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

    const db = await getDb();
    const user = await db.collection("users").findOne(
      { id: payload.id },
      { projection: { _id: 0, id: 1, password_hash: 1, is_active: 1 } }
    );

    if (!user || user.is_active === false) {
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

    const newHash = await bcrypt.hash(String(newPassword), 10);
    await db
      .collection("users")
      .updateOne({ id: payload.id }, { $set: { password_hash: newHash } });

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
