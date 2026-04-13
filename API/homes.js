const express = require("express");
const { getDb, nextId } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const {
  isManager,
  listHomesForUser,
  pick,
  userRole,
} = require("../services/mongoData");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  const { name, timezone } = req.body || {};
  if (!name) return res.status(400).json({ message: "name required" });

  try {
    const db = await getDb();
    const homeId = await nextId("homes");

    await db.collection("homes").insertOne({
      id: homeId,
      name,
      timezone: timezone || "Africa/Cairo",
      created_by: req.user.id,
      created_at: new Date(),
    });
    await db.collection("homeMembers").insertOne({
      home_id: homeId,
      user_id: req.user.id,
      role: "owner",
    });

    return res.status(201).json({ id: homeId });
  } catch (e) {
    console.error("create home error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    return res.json(await listHomesForUser(req.user.id));
  } catch (e) {
    console.error("list homes error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.get("/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await getDb();
    const role = await userRole(homeId, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const home = await db
      .collection("homes")
      .findOne({ id: homeId }, { projection: { _id: 0 } });
    if (!home) return res.status(404).json({ message: "not found" });

    return res.json(
      pick(home, ["id", "name", "timezone", "created_by", "created_at"])
    );
  } catch (e) {
    console.error("get home error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.put("/", requireAuth, async (req, res) => {
  const { name, timezone, homeId } = req.body || {};
  try {
    const db = await getDb();
    const role = await userRole(homeId, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    const $set = {};
    if (name) $set.name = name;
    if (timezone) $set.timezone = timezone;

    if (Object.keys($set).length) {
      await db.collection("homes").updateOne({ id: Number(homeId) }, { $set });
    }

    return res.json({ status: true });
  } catch (e) {
    console.error("update home error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.delete("/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await getDb();
    const role = await userRole(homeId, req.user.id);
    if (role !== "owner") {
      return res.status(403).json({ message: "owner only" });
    }

    const devices = await db.collection("devices").countDocuments({
      home_id: homeId,
    });
    const rooms = await db.collection("rooms").countDocuments({
      home_id: homeId,
    });
    if (devices > 0 || rooms > 0) {
      return res.status(409).json({ message: "home not empty" });
    }

    await db.collection("homeMembers").deleteMany({ home_id: homeId });
    await db.collection("homes").deleteOne({ id: homeId });

    return res.json({ status: true });
  } catch (e) {
    console.error("delete home error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.post("/:homeId/members", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  const { user_id, role } = req.body || {};
  if (!user_id || !role) {
    return res.status(400).json({ message: "user_id and role required" });
  }

  try {
    const db = await getDb();
    const myRole = await userRole(homeId, req.user.id);
    if (!isManager(myRole)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    await db.collection("homeMembers").updateOne(
      { home_id: homeId, user_id: Number(user_id) },
      { $set: { role } },
      { upsert: true }
    );
    return res.json({ status: true });
  } catch (e) {
    console.error("add member error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.delete("/:homeId/members/:userId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  const targetUserId = Number(req.params.userId);
  try {
    const db = await getDb();
    const myRole = await userRole(homeId, req.user.id);
    if (!isManager(myRole)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    const role = await userRole(homeId, targetUserId);
    if (role === "owner") {
      return res.status(409).json({ message: "cannot remove owner" });
    }

    await db
      .collection("homeMembers")
      .deleteOne({ home_id: homeId, user_id: targetUserId });
    return res.json({ status: true });
  } catch (e) {
    console.error("remove member error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.get("/:homeId/members", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const db = await getDb();
    const myRole = await userRole(homeId, req.user.id);
    if (!isManager(myRole)) {
      return res.status(403).json({ message: "admin/owner only" });
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
        { projection: { _id: 0, id: 1, email: 1 } }
      )
      .toArray();
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const roleRank = { owner: 0, admin: 1 };

    const out = [];
    for (const member of memberships.sort((a, b) => {
      const roleDiff =
        (roleRank[a.role] ?? 2) - (roleRank[b.role] ?? 2);
      return roleDiff || a.user_id - b.user_id;
    })) {
      const access = await db
        .collection("homeRoomAccess")
        .find(
          { home_id: homeId, user_id: member.user_id },
          { projection: { _id: 0, room_id: 1 } }
        )
        .sort({ room_id: 1 })
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

      out.push({
        user_id: member.user_id,
        email: emailById.get(member.user_id),
        role: member.role,
        allowed_room_ids: roomIds.length ? roomIds : null,
        allowed_rooms: rooms.length
          ? rooms.map((room) => pick(room, ["id", "name"]))
          : null,
      });
    }

    return res.json(out);
  } catch (e) {
    console.error("list members error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
