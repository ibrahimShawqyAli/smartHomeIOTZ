const express = require("express");
const { getDb, nextId } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const {
  duplicateKey,
  isManager,
  listVisibleRooms,
  pick,
  userRole,
} = require("../services/mongoData");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  const {
    home_id,
    name,
    icon_path,
    sort_order = 0,
    is_private = false,
  } = req.body;

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
    const db = await getDb();
    const homeId = Number(home_id);
    const role = await userRole(homeId, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({
        code: "FORBIDDEN",
        message: "Only owner/admin can create rooms in this home.",
      });
    }

    if (await db.collection("rooms").findOne({ home_id: homeId, name })) {
      return res.status(409).json({
        code: "ROOM_NAME_ALREADY_EXISTS",
        message: "A room with this name already exists in this home.",
      });
    }

    const room = {
      id: await nextId("rooms"),
      home_id: homeId,
      name,
      sort_order: Number(sort_order) || 0,
      is_private: !!is_private,
      created_by: req.user.id,
      icon_path: String(icon_path).trim(),
      created_at: new Date(),
    };
    await db.collection("rooms").insertOne(room);

    await db
      .collection("homeRoomAccess")
      .deleteMany({ home_id: homeId, room_id: room.id });

    if (room.is_private) {
      await db.collection("homeRoomAccess").insertOne({
        home_id: homeId,
        user_id: req.user.id,
        room_id: room.id,
      });
    }

    return res.status(201).json({
      status: true,
      message: "Room created successfully",
      room: pick(room, [
        "id",
        "home_id",
        "name",
        "sort_order",
        "is_private",
        "icon_path",
      ]),
    });
  } catch (e) {
    if (duplicateKey(e)) {
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

router.get("/home/:homeId", requireAuth, async (req, res) => {
  const homeId = Number(req.params.homeId);
  try {
    const role = await userRole(homeId, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const rooms = await listVisibleRooms(homeId, req.user.id, role);
    return res.json(
      rooms.map((room) =>
        pick(room, ["id", "home_id", "name", "sort_order", "is_private"])
      )
    );
  } catch (e) {
    console.error("list rooms error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.put("/:roomId", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const { name, sort_order, is_private, icon_path } = req.body || {};

  try {
    const db = await getDb();
    const room = await db
      .collection("rooms")
      .findOne({ id: roomId }, { projection: { _id: 0 } });
    if (!room) return res.status(404).json({ message: "room not found" });

    const role = await userRole(room.home_id, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    if (name) {
      const dup = await db.collection("rooms").findOne({
        home_id: room.home_id,
        name,
        id: { $ne: roomId },
      });
      if (dup) {
        return res.status(409).json({
          code: "ROOM_NAME_ALREADY_EXISTS",
          message: "A room with this name already exists in this home.",
        });
      }
    }

    const $set = {};
    if (name) $set.name = name;
    if (sort_order !== undefined && sort_order !== null) {
      $set.sort_order = Number(sort_order);
    }
    if (typeof is_private === "boolean") $set.is_private = is_private;
    if (icon_path !== undefined && icon_path !== null) $set.icon_path = icon_path;

    if (Object.keys($set).length) {
      await db.collection("rooms").updateOne({ id: roomId }, { $set });
    }

    if (typeof is_private === "boolean") {
      await db
        .collection("homeRoomAccess")
        .deleteMany({ home_id: room.home_id, room_id: roomId });

      if (is_private && room.created_by) {
        await db.collection("homeRoomAccess").updateOne(
          {
            home_id: room.home_id,
            user_id: room.created_by,
            room_id: roomId,
          },
          {
            $setOnInsert: {
              home_id: room.home_id,
              user_id: room.created_by,
              room_id: roomId,
            },
          },
          { upsert: true }
        );
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("update room error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.delete("/:roomId", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  try {
    const db = await getDb();
    const room = await db
      .collection("rooms")
      .findOne({ id: roomId }, { projection: { _id: 0, home_id: 1 } });
    if (!room) return res.status(404).json({ message: "room not found" });

    const role = await userRole(room.home_id, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    const hasDevices = await db.collection("devices").countDocuments({
      room_id: roomId,
    });
    if (hasDevices > 0) {
      return res.status(409).json({ message: "room not empty (has devices)" });
    }

    await db
      .collection("homeRoomAccess")
      .deleteMany({ home_id: room.home_id, room_id: roomId });
    await db.collection("rooms").deleteOne({ id: roomId });

    return res.json({ ok: true });
  } catch (e) {
    console.error("delete room error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

router.post("/:roomId/move-device", requireAuth, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const { device_id } = req.body || {};
  if (!device_id) {
    return res
      .status(400)
      .json({ message: "device_id required (internal PK)" });
  }

  try {
    const db = await getDb();
    const room = await db
      .collection("rooms")
      .findOne({ id: roomId }, { projection: { _id: 0, home_id: 1 } });
    if (!room) return res.status(404).json({ message: "room not found" });

    const role = await userRole(room.home_id, req.user.id);
    if (!isManager(role)) {
      return res.status(403).json({ message: "admin/owner only" });
    }

    const device = await db.collection("devices").findOne(
      { id: Number(device_id) },
      { projection: { _id: 0, id: 1, home_id: 1 } }
    );
    if (!device) return res.status(404).json({ message: "device not found" });
    if (device.home_id !== room.home_id) {
      return res.status(409).json({ message: "device not in this home" });
    }

    await db
      .collection("devices")
      .updateOne({ id: Number(device_id) }, { $set: { room_id: roomId } });

    return res.json({ ok: true });
  } catch (e) {
    console.error("move device error:", e);
    return res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
