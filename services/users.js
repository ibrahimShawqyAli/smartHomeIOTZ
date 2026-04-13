const { getDb, nextId } = require("../DB/mongo");
const { cleanDoc, userRole } = require("./mongoData");

async function getUserById(id) {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { id: Number(id) },
    { projection: { _id: 0, id: 1, email: 1, is_active: 1 } }
  );
  return cleanDoc(user);
}

async function findUserByEmail(email) {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { email: String(email || "").trim().toLowerCase() },
    {
      projection: {
        _id: 0,
        id: 1,
        email: 1,
        password_hash: 1,
        is_active: 1,
      },
    }
  );
  return cleanDoc(user);
}

async function saveRefreshToken(userId, token, expiresAt) {
  const db = await getDb();
  await db.collection("refreshTokens").insertOne({
    id: await nextId("refreshTokens"),
    user_id: Number(userId),
    token,
    expires_at: expiresAt,
    created_at: new Date(),
  });
}

async function isMember(userId, homeId) {
  return userRole(homeId, userId);
}

module.exports = { getUserById, findUserByEmail, saveRefreshToken, isMember };
