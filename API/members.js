const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb, nextId } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const {
  duplicateKey,
  isManager,
  pick,
  userRole,
} = require("../services/mongoData");

const router = express.Router();

router.post("/:homeId/", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  const {
    email,
    password,
    role = "member",
    allowed_room_ids,
    name,
    mobile,
  } = req.body || {};

  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail || !role) {
    return res.status(400).json({
      status: false,
      message: "email and role are required",
    });
  }

  try {
    const db = await getDb();
    const callerRole = await userRole(homeId, req.user.id);
    if (!isManager(callerRole)) {
      return res.status(403).json({
        status: false,
        message: "admin/owner only",
      });
    }

    let roomIds = null;
    if (Array.isArray(allowed_room_ids)) {
      const parsedRoomIds = allowed_room_ids.map(Number);
      if (parsedRoomIds.some((rid) => !Number.isFinite(rid))) {
        return res.status(400).json({
          status: false,
          message: "one or more room_ids are invalid for this home",
        });
      }

      roomIds = [...new Set(parsedRoomIds)];
      if (roomIds.length) {
        const validCount = await db.collection("rooms").countDocuments({
          home_id: homeId,
          id: { $in: roomIds },
        });

        if (validCount !== roomIds.length) {
          return res.status(400).json({
            status: false,
            message: "one or more room_ids are invalid for this home",
          });
        }
      }
    }

    const users = db.collection("users");
    let user = await users.findOne(
      { email: normalizedEmail },
      { projection: { _id: 0, id: 1 } }
    );
    let userId;

    if (user) {
      userId = user.id;
      const $set = {};
      if ((name || "").trim()) $set.name = name.trim();
      if ((mobile || "").trim()) $set.mobile = mobile.trim();

      if (Object.keys($set).length) {
        await users.updateOne({ id: userId }, { $set });
      }
    } else {
      if (!password) {
        return res.status(400).json({
          status: false,
          message: "password required to create a new user",
        });
      }

      const safeName =
        (name || "").trim() ||
        (normalizedEmail.includes("@")
          ? normalizedEmail.split("@")[0]
          : "Member");
      const safeMobile = (mobile || "").trim() || null;

      userId = await nextId("users");
      await users.insertOne({
        id: userId,
        name: safeName,
        email: normalizedEmail,
        mobile: safeMobile,
        password_hash: await bcrypt.hash(password, 10),
        is_active: true,
        created_at: new Date(),
      });
    }

    await db.collection("homeMembers").updateOne(
      { home_id: homeId, user_id: userId },
      { $set: { role } },
      { upsert: true }
    );

    if (Array.isArray(allowed_room_ids)) {
      await db.collection("homeRoomAccess").deleteMany({
        home_id: homeId,
        user_id: userId,
      });

      if (roomIds.length) {
        await db.collection("homeRoomAccess").insertMany(
          roomIds.map((roomId) => ({
            home_id: homeId,
            user_id: userId,
            room_id: roomId,
          }))
        );
      }
    }

    return res.status(201).json({
      status: true,
      message: "member added/updated successfully",
      user_id: userId,
      home_id: homeId,
      role,
      allowed_room_ids: roomIds,
    });
  } catch (err) {
    if (duplicateKey(err)) {
      return res.status(409).json({
        status: false,
        message: "email, mobile, or room access already exists",
      });
    }
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
    const db = await getDb();
    const callerRole = await userRole(homeId, req.user.id);
    if (!isManager(callerRole)) {
      return res.status(403).json({
        status: false,
        message: "Only owner/admin can view home members.",
      });
    }

    const memberships = await db
      .collection("homeMembers")
      .find({ home_id: homeId }, { projection: { _id: 0 } })
      .toArray();
    const userIds = memberships.map((m) => m.user_id);
    const users = await db
      .collection("users")
      .find(
        { id: { $in: userIds } },
        { projection: { _id: 0, id: 1, name: 1, email: 1, mobile: 1 } }
      )
      .toArray();

    const userById = new Map(users.map((u) => [u.id, u]));
    const roleRank = { owner: 0, admin: 1, member: 2 };
    const members = [];

    for (const membership of memberships.sort((a, b) => {
      const roleDiff =
        (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3);
      const aName = userById.get(a.user_id)?.name || "";
      const bName = userById.get(b.user_id)?.name || "";
      return roleDiff || aName.localeCompare(bName);
    })) {
      const user = userById.get(membership.user_id) || {};
      const access = await db
        .collection("homeRoomAccess")
        .find(
          { home_id: homeId, user_id: membership.user_id },
          { projection: { _id: 0, room_id: 1 } }
        )
        .toArray();
      const roomIds = access.map((row) => row.room_id);
      const rooms = roomIds.length
        ? await db
            .collection("rooms")
            .find(
              { home_id: homeId, id: { $in: roomIds } },
              { projection: { _id: 0, id: 1, name: 1, sort_order: 1 } }
            )
            .sort({ sort_order: 1, id: 1 })
            .toArray()
        : [];

      members.push({
        user_id: membership.user_id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: membership.role,
        allowed_rooms: rooms.map((room) => pick(room, ["id", "name"])),
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
