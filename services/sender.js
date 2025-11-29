// services/sender.js
const { logCommand, setCommandStatus } = require("./commandStore");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const WebSocket = require("ws");

// NOTE: import *only* the exported map from WS layer
const { deviceClients } = require("../WS/websocket"); // map: devicePk -> ws

async function sendControlToDevice({ devicePk, payload, issuedBy = null }) {
  // 1) log command
  const logId = await logCommand({
    devicePk,
    issuedBy,
    source: "api",
    payload: JSON.stringify(payload),
    status: "sent",
  });

  // 2) try live WS
  const ws = deviceClients.get(devicePk);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ type: "control", payload, msg_id: String(logId) })
    );
    // Device will reply with {type:"ack", msg_id, ok, error?}; WS layer will call setCommandStatus there.
  } else {
    // 3) queue in DB for later (optional)
    const db = await poolPromise;
    await db
      .request()
      .input("d", sql.Int, devicePk)
      .input("p", sql.NVarChar, JSON.stringify(payload))
      .query("INSERT INTO PendingCommands(device_id, payload) VALUES(@d, @p)");
    await setCommandStatus(logId, "queued");
  }

  return logId;
}

module.exports = { sendControlToDevice };
