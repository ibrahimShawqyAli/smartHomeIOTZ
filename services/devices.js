const { getDb, nextId } = require("../DB/mongo");
const { cleanDoc, cleanDocs, pick } = require("./mongoData");

async function getDeviceByPublicId(device_id) {
  const db = await getDb();
  const device = await db.collection("devices").findOne(
    { device_id },
    {
      projection: {
        _id: 0,
        id: 1,
        device_id: 1,
        device_secret: 1,
        home_id: 1,
        room_id: 1,
        name: 1,
        type: 1,
      },
    }
  );
  return cleanDoc(device);
}

async function getDeviceByPk(id) {
  const db = await getDb();
  const device = await db.collection("devices").findOne(
    { id: Number(id) },
    {
      projection: {
        _id: 0,
        id: 1,
        device_id: 1,
        device_secret: 1,
        home_id: 1,
        room_id: 1,
        name: 1,
        type: 1,
      },
    }
  );
  return cleanDoc(device);
}

async function listDevicesByHome(homeId) {
  const db = await getDb();
  const devices = await db
    .collection("devices")
    .find({ home_id: Number(homeId) }, { projection: { _id: 0 } })
    .sort({ id: -1 })
    .toArray();
  return cleanDocs(devices).map((device) =>
    pick(device, ["id", "device_id", "name", "type", "room_id", "is_active"])
  );
}

async function markDeviceOnline() {
  return true;
}

async function markDeviceOffline() {
  return true;
}

async function saveShadow(devicePk, reportedStateJson) {
  const db = await getDb();
  await db.collection("deviceShadows").updateOne(
    { device_id: Number(devicePk) },
    {
      $set: {
        reported_state: reportedStateJson,
        updated_at: new Date(),
      },
      $setOnInsert: { device_id: Number(devicePk) },
    },
    { upsert: true }
  );
}

async function fetchPending(devicePk) {
  const db = await getDb();
  return cleanDocs(
    await db
      .collection("pendingCommands")
      .find(
        {
          device_id: Number(devicePk),
          expire_at: { $gt: new Date() },
        },
        { projection: { _id: 0, id: 1, payload: 1 } }
      )
      .sort({ created_at: 1 })
      .limit(50)
      .toArray()
  );
}

async function deletePending(id) {
  const db = await getDb();
  await db.collection("pendingCommands").deleteOne({ id: Number(id) });
}

async function enqueuePending(devicePk, payload, expireAt = null) {
  const db = await getDb();
  await db.collection("pendingCommands").insertOne({
    id: await nextId("pendingCommands"),
    device_id: Number(devicePk),
    payload,
    expire_at: expireAt || new Date(Date.now() + 10 * 60 * 1000),
    created_at: new Date(),
  });
}

module.exports = {
  getDeviceByPublicId,
  getDeviceByPk,
  listDevicesByHome,
  markDeviceOnline,
  markDeviceOffline,
  saveShadow,
  fetchPending,
  deletePending,
  enqueuePending,
};
