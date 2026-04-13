const { getDb, nextId } = require("../DB/mongo");
const { listHomesForUser } = require("./mongoData");

async function createHome({ name, timezone, createdBy }) {
  const db = await getDb();
  const homeId = await nextId("homes");

  await db.collection("homes").insertOne({
    id: homeId,
    name,
    timezone: timezone || "Africa/Cairo",
    created_by: Number(createdBy),
    created_at: new Date(),
  });
  await db.collection("homeMembers").insertOne({
    home_id: homeId,
    user_id: Number(createdBy),
    role: "owner",
  });

  return homeId;
}

async function addMember({ homeId, userId, role, guestExpiresAt = null }) {
  const db = await getDb();
  await db.collection("homeMembers").updateOne(
    { home_id: Number(homeId), user_id: Number(userId) },
    {
      $set: {
        role,
        guest_expires_at: guestExpiresAt,
      },
    },
    { upsert: true }
  );
}

module.exports = { createHome, addMember, listHomesForUser };
