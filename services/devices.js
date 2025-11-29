const { sql, poolPromise } = require("../SQL/sqlSetup");

async function getDeviceByPublicId(device_id) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("d", sql.VarChar, device_id)
    .query(
      "SELECT id, device_id, device_secret, home_id, room_id, name, type FROM Devices WHERE device_id=@d"
    );
  return r.recordset[0] || null;
}

async function getDeviceByPk(id) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("id", sql.Int, id)
    .query(
      "SELECT id, device_id, device_secret, home_id, room_id, name, type FROM Devices WHERE id=@id"
    );
  return r.recordset[0] || null;
}

async function listDevicesByHome(homeId) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("h", sql.Int, homeId)
    .query(
      "SELECT id, device_id, name, type, room_id, is_active FROM Devices WHERE home_id=@h ORDER BY id DESC"
    );
  return r.recordset;
}

/** Optional online/offline markers – if you want a column, add it; here we just no-op */
async function markDeviceOnline(/* devicePk */) {
  return true;
}
async function markDeviceOffline(/* devicePk */) {
  return true;
}

async function saveShadow(devicePk, reportedStateJson) {
  const db = await poolPromise;
  await db
    .request()
    .input("id", sql.Int, devicePk)
    .input("rs", sql.NVarChar, reportedStateJson).query(`
      MERGE DeviceShadows AS t
      USING (SELECT @id AS device_id) s ON (t.device_id=s.device_id)
      WHEN MATCHED THEN UPDATE SET reported_state=@rs, updated_at=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT(device_id, reported_state) VALUES(@id, @rs);
    `);
}

async function fetchPending(devicePk) {
  const db = await poolPromise;
  const r = await db.request().input("d", sql.Int, devicePk).query(`
      SELECT TOP (50) id, payload
      FROM PendingCommands
      WHERE device_id=@d AND expire_at > SYSUTCDATETIME()
      ORDER BY created_at ASC
    `);
  return r.recordset;
}

async function deletePending(id) {
  const db = await poolPromise;
  await db
    .request()
    .input("id", sql.BigInt, id)
    .query("DELETE FROM PendingCommands WHERE id=@id");
}

async function enqueuePending(devicePk, payload, expireAt) {
  const db = await poolPromise;
  await db
    .request()
    .input("d", sql.Int, devicePk)
    .input("p", sql.NVarChar, payload)
    .input("x", sql.DateTime2, expireAt)
    .query(
      "INSERT INTO PendingCommands(device_id, payload, expire_at) VALUES(@d,@p,@x)"
    );
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
