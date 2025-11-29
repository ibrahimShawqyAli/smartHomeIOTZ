const { sql, poolPromise } = require("../SQL/sqlSetup");
const { deviceClients } = require("../WS/websocket");
const devices = require("./devices");

async function logCommand({
  devicePk,
  issuedBy = null,
  source,
  payload,
  status,
}) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("d", sql.Int, devicePk)
    .input("u", sql.Int, issuedBy)
    .input("s", sql.VarChar, source) // 'api' | 'schedule' | 'automation'
    .input("p", sql.NVarChar, payload) // JSON string
    .input("st", sql.VarChar, status) // 'sent' | 'queued' | 'ack' | 'failed' | 'timeout'
    .query(`
      INSERT INTO CommandLog(device_id, issued_by, source, payload, status)
      OUTPUT inserted.id
      VALUES(@d, @u, @s, @p, @st)
    `);
  return r.recordset[0].id;
}

async function setCommandStatus(id, status, errorMessage = null) {
  const db = await poolPromise;
  await db
    .request()
    .input("id", sql.BigInt, id)
    .input("st", sql.VarChar, status)
    .input("em", sql.NVarChar, errorMessage).query(`
      UPDATE CommandLog
      SET status=@st,
          ack_at = CASE WHEN @st IN ('ack','failed','timeout') THEN SYSUTCDATETIME() ELSE ack_at END,
          error_message = @em
      WHERE id=@id
    `);
}

async function sendControlToDevice({ devicePk, payload, issuedBy = null }) {
  const logId = await logCommand({
    devicePk,
    issuedBy,
    source: "api",
    payload: JSON.stringify(payload),
    status: "sent",
  });

  const ws = deviceClients.get(devicePk);
  if (ws && ws.readyState === 1) {
    ws.send(
      JSON.stringify({ type: "control", payload, msg_id: String(logId) })
    );
  } else {
    await devices.enqueuePending(
      devicePk,
      JSON.stringify(payload),
      new Date(Date.now() + 10 * 60 * 1000) // 10 min expiry
    );
    await setCommandStatus(logId, "queued");
  }
  return logId;
}

module.exports = { logCommand, setCommandStatus, sendControlToDevice };
