const { sql, poolPromise } = require("../SQL/sqlSetup");

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
  const db = await poolPromise;
  await db
    .request()
    .input("h", sql.Int, homeId)
    .input("d", sql.Int, devicePk)
    .input("s", sql.Int, scenePk)
    .input("a", sql.NVarChar, actionJson)
    .input("r", sql.VarChar, rrule)
    .input("c", sql.VarChar, cron)
    .input("tz", sql.VarChar, timezone)
    .input("u", sql.Int, createdBy).query(`
      INSERT INTO Schedules(home_id, device_id, scene_id, action, rrule, cron, timezone, created_by)
      VALUES(@h,@d,@s,@a,@r,@c,@tz,@u)
    `);
}

async function listActiveSchedules() {
  const db = await poolPromise;
  const r = await db
    .request()
    .query("SELECT * FROM Schedules WHERE is_active=1");
  return r.recordset;
}

async function toggleSchedule(id, active) {
  const db = await poolPromise;
  await db
    .request()
    .input("id", sql.Int, id)
    .input("a", sql.Bit, active ? 1 : 0)
    .query("UPDATE Schedules SET is_active=@a WHERE id=@id");
}

module.exports = { createSchedule, listActiveSchedules, toggleSchedule };
