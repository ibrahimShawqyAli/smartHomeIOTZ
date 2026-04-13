const express = require("express");
const { getDb } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const { sendControlToDevice } = require("../services/sender");
const {
  canAccessRoom,
  isManager,
  listVisibleDevices,
  mergeMetaStatus,
  pick,
  userRole,
} = require("../services/mongoData");

const router = express.Router();

router.post("/claim", requireAuth, async (req, res) => {
  const { device_id, device_secret, home_id, name, icon_path } = req.body;

  try {
    const db = await getDb();
    const role = await userRole(home_id, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const row = await db
      .collection("devices")
      .find({ device_id }, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .limit(1)
      .next();

    if (!row) {
      return res.status(404).json({ message: "device not connected yet" });
    }
    if (row.home_id && row.home_id !== Number(home_id)) {
      return res.status(409).json({ message: "device already claimed" });
    }
    if (row.device_secret !== device_secret) {
      return res.status(403).json({ message: "secret mismatch" });
    }

    await db.collection("devices").updateOne(
      { id: row.id },
      {
        $set: {
          home_id: Number(home_id),
          name: name || device_id,
          icon_path: icon_path || "assets/images/lights.png",
          meta: mergeMetaStatus(row.meta, "claimed"),
        },
      }
    );

    return res.json({ ok: true, devicePk: row.id });
  } catch (err) {
    console.error("claim device error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

router.get("/home/:homeId", requireAuth, async (req, res) => {
  const hid = Number(req.params.homeId);

  try {
    const db = await getDb();
    const role = await userRole(hid, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const devices = await listVisibleDevices(hid, req.user.id, role);
    const fields = [
      "id",
      "device_id",
      "name",
      "type",
      "room_id",
      "meta",
      "is_active",
    ];

    if (!isManager(role)) {
      return res.json(devices.map((device) => pick(device, fields)));
    }

    const roomIds = [...new Set(devices.map((d) => d.room_id).filter(Boolean))];
    const rooms = await db
      .collection("rooms")
      .find(
        { id: { $in: roomIds } },
        { projection: { _id: 0, id: 1, is_private: 1 } }
      )
      .toArray();
    const privacyByRoom = new Map(
      rooms.map((room) => [room.id, room.is_private])
    );

    return res.json(
      devices.map((device) => ({
        ...pick(device, fields),
        is_private: privacyByRoom.get(device.room_id),
      }))
    );
  } catch (err) {
    console.error("list devices error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

router.post("/:devicePk/control", requireAuth, async (req, res) => {
  const devicePk = Number(req.params.devicePk);
  const payload = req.body;

  try {
    const db = await getDb();
    const dev = await db.collection("devices").findOne(
      { id: devicePk },
      { projection: { _id: 0, home_id: 1, room_id: 1 } }
    );
    if (!dev) return res.status(404).json({ message: "device not found" });

    const role = await userRole(dev.home_id, req.user.id);
    if (!role) return res.status(403).json({ message: "not in home" });

    const allowed = await canAccessRoom(
      dev.home_id,
      dev.room_id,
      req.user.id,
      role
    );
    if (!allowed) {
      return res
        .status(403)
        .json({ message: "no permission for this room/device" });
    }

    await sendControlToDevice({ devicePk, payload, issuedBy: req.user.id });
    return res.json({ status: true });
  } catch (err) {
    console.error("control device error:", err);
    return res.status(500).json({ message: "internal error" });
  }
});

module.exports = router;
