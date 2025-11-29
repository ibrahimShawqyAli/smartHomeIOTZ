const { sql, poolPromise } = require("../SQL/sqlSetup");

async function getUserById(id) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("id", sql.Int, id)
    .query("SELECT id, email, is_active FROM Users WHERE id=@id");
  return r.recordset[0] || null;
}

async function findUserByEmail(email) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("e", sql.VarChar, email)
    .query(
      "SELECT id, email, password_hash, is_active FROM Users WHERE email=@e"
    );
  return r.recordset[0] || null;
}

async function saveRefreshToken(userId, token, expiresAt) {
  const db = await poolPromise;
  await db
    .request()
    .input("u", sql.Int, userId)
    .input("t", sql.VarChar, token)
    .input("x", sql.DateTime2, expiresAt)
    .query(
      "INSERT INTO RefreshTokens(user_id, token, expires_at) VALUES(@u,@t,@x)"
    );
}

async function isMember(userId, homeId) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("u", sql.Int, userId)
    .input("h", sql.Int, homeId)
    .query("SELECT role FROM HomeMembers WHERE user_id=@u AND home_id=@h");
  return r.recordset[0] ? r.recordset[0].role : null;
}

module.exports = { getUserById, findUserByEmail, saveRefreshToken, isMember };
