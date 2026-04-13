const { logCommand, setCommandStatus } = require("./commandStore");
const { deviceClients } = require("../WS/websocket");
const devices = require("./devices");

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
      new Date(Date.now() + 10 * 60 * 1000)
    );
    await setCommandStatus(logId, "queued");
  }
  return logId;
}

module.exports = { logCommand, setCommandStatus, sendControlToDevice };
