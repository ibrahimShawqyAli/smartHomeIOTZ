// services/commandStore.js
const { sql, poolPromise } = require("../SQL/sqlSetup");

async function logCommand({ devicePk, issuedBy, source, payload, status }) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("d", sql.Int, devicePk)
    .input("u", sql.Int, issuedBy || null)
    .input("s", sql.VarChar, source || "api")
    .input("p", sql.NVarChar, payload)
    .input("st", sql.VarChar, status || "sent").query(`
      INSERT INTO CommandLog(device_id, issued_by, source, payload, status, created_at)
      OUTPUT inserted.id
      VALUES(@d, @u, @s, @p, @st, SYSDATETIMEOFFSET())
    `);
  return r.recordset[0].id;
}

async function setCommandStatus(id, status, error = null) {
  const db = await poolPromise;
  await db
    .request()
    .input("id", sql.BigInt, id)
    .input("st", sql.VarChar, status)
    .input("er", sql.NVarChar, error).query(`
      UPDATE CommandLog
      SET status=@st, error=@er, updated_at=SYSDATETIMEOFFSET()
      WHERE id=@id
    `);
}

module.exports = { logCommand, setCommandStatus };
