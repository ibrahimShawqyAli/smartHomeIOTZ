const { getDb } = require("../DB/mongo");

function duplicateKey(err) {
  return err && err.code === 11000;
}

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

function cleanDocs(docs) {
  return docs.map(cleanDoc);
}

function pick(doc, fields) {
  const out = {};
  for (const field of fields) {
    if (doc[field] !== undefined) out[field] = doc[field];
  }
  return out;
}

function isManager(role) {
  return role === "owner" || role === "admin";
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function userRole(homeId, userId) {
  const db = await getDb();
  const member = await db.collection("homeMembers").findOne(
    {
      home_id: Number(homeId),
      user_id: Number(userId),
    },
    { projection: { _id: 0, role: 1 } }
  );
  return member?.role || null;
}

async function listHomesForUser(userId) {
  const db = await getDb();
  const memberships = await db
    .collection("homeMembers")
    .find({ user_id: Number(userId) }, { projection: { _id: 0 } })
    .toArray();

  if (!memberships.length) return [];

  const roleByHome = new Map(memberships.map((m) => [m.home_id, m.role]));
  const homes = await db
    .collection("homes")
    .find(
      { id: { $in: [...roleByHome.keys()] } },
      { projection: { _id: 0, id: 1, name: 1, timezone: 1 } }
    )
    .sort({ id: -1 })
    .toArray();

  return homes.map((home) => ({ ...home, role: roleByHome.get(home.id) }));
}

async function allowedRoomIds(homeId, userId) {
  const db = await getDb();
  return db.collection("homeRoomAccess").distinct("room_id", {
    home_id: Number(homeId),
    user_id: Number(userId),
  });
}

async function listVisibleRooms(homeId, userId, role) {
  const db = await getDb();
  const hid = Number(homeId);

  let filter = { home_id: hid };
  if (!isManager(role)) {
    const aclIds = await allowedRoomIds(hid, userId);
    filter = {
      home_id: hid,
      $or: [
        { is_private: { $ne: true } },
        { created_by: Number(userId) },
        { id: { $in: aclIds } },
      ],
    };
  }

  return cleanDocs(
    await db
      .collection("rooms")
      .find(filter, { projection: { _id: 0 } })
      .sort({ sort_order: 1, id: 1 })
      .toArray()
  );
}

async function canAccessRoom(homeId, roomId, userId, role) {
  if (!roomId || isManager(role)) return true;

  const db = await getDb();
  const room = await db.collection("rooms").findOne(
    {
      id: Number(roomId),
      home_id: Number(homeId),
    },
    { projection: { _id: 0, is_private: 1, created_by: 1 } }
  );

  if (!room) return false;
  if (room.is_private !== true) return true;
  if (room.created_by === Number(userId)) return true;

  const access = await db.collection("homeRoomAccess").findOne({
    home_id: Number(homeId),
    user_id: Number(userId),
    room_id: Number(roomId),
  });
  return !!access;
}

async function listVisibleDevices(homeId, userId, role) {
  const db = await getDb();
  const hid = Number(homeId);

  let filter = { home_id: hid };
  if (!isManager(role)) {
    const rooms = await listVisibleRooms(hid, userId, role);
    const roomIds = rooms.map((room) => room.id);
    filter = {
      home_id: hid,
      $or: [
        { room_id: null },
        { room_id: { $exists: false } },
        { room_id: { $in: roomIds } },
      ],
    };
  }

  return cleanDocs(
    await db
      .collection("devices")
      .find(filter, { projection: { _id: 0 } })
      .sort({ id: -1 })
      .toArray()
  );
}

async function getOverview(userId) {
  const homes = await listHomesForUser(userId);
  const overview = [];

  for (const h of homes) {
    const rooms = await listVisibleRooms(h.id, userId, h.role);
    const devices = await listVisibleDevices(h.id, userId, h.role);

    overview.push({
      home: { id: h.id, name: h.name, timezone: h.timezone, role: h.role },
      rooms: rooms.map((room) =>
        pick(room, ["id", "home_id", "name", "sort_order", "is_private", "icon_path"])
      ),
      devices: devices.map((device) =>
        pick(device, [
          "id",
          "device_id",
          "name",
          "type",
          "room_id",
          "pin",
          "meta",
          "is_active",
          "icon_path",
        ])
      ),
    });
  }

  return overview;
}

function mergeMetaStatus(meta, status) {
  let value = {};
  if (typeof meta === "string" && meta.trim()) {
    try {
      value = JSON.parse(meta);
    } catch {
      value = {};
    }
  } else if (meta && typeof meta === "object") {
    value = { ...meta };
  }

  value.status = status;
  return JSON.stringify(value);
}

module.exports = {
  allowedRoomIds,
  canAccessRoom,
  cleanDoc,
  cleanDocs,
  duplicateKey,
  getOverview,
  isManager,
  listHomesForUser,
  listVisibleDevices,
  listVisibleRooms,
  mergeMetaStatus,
  pick,
  toNumberOrNull,
  userRole,
};
