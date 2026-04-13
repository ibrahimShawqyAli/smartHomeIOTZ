const { getDb, nextId } = require("../DB/mongo");
const { cleanDocs } = require("./mongoData");

async function createSchedule({
  homeId,
  devicePk = null,
  scenePk = null,
  actionJson = null,
  rrule = null,
  cron = null,
  timezone,
  createdBy,
}) {
  const db = await getDb();
  await db.collection("schedules").insertOne({
    id: await nextId("schedules"),
    home_id: Number(homeId),
    device_id: devicePk == null ? null : Number(devicePk),
    scene_id: scenePk == null ? null : Number(scenePk),
    action: actionJson,
    rrule,
    cron,
    timezone,
    created_by: Number(createdBy),
    is_active: true,
    created_at: new Date(),
  });
}

async function listActiveSchedules() {
  const db = await getDb();
  return cleanDocs(
    await db
      .collection("schedules")
      .find({ is_active: true }, { projection: { _id: 0 } })
      .toArray()
  );
}

async function toggleSchedule(id, active) {
  const db = await getDb();
  await db
    .collection("schedules")
    .updateOne({ id: Number(id) }, { $set: { is_active: !!active } });
}

module.exports = { createSchedule, listActiveSchedules, toggleSchedule };
