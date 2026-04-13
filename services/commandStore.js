const { getDb, nextId } = require("../DB/mongo");

async function logCommand({ devicePk, issuedBy, source, payload, status }) {
  const db = await getDb();
  const id = await nextId("commandLog");

  await db.collection("commandLog").insertOne({
    id,
    device_id: Number(devicePk),
    issued_by: issuedBy || null,
    source: source || "api",
    payload,
    status: status || "sent",
    created_at: new Date(),
    updated_at: new Date(),
  });

  return id;
}

async function setCommandStatus(id, status, error = null) {
  const db = await getDb();
  const $set = {
    status,
    error,
    updated_at: new Date(),
  };

  if (["ack", "failed", "timeout"].includes(status)) {
    $set.ack_at = new Date();
  }

  await db.collection("commandLog").updateOne({ id: Number(id) }, { $set });
}

module.exports = { logCommand, setCommandStatus };
