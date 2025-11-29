const { sql, poolPromise } = require("../SQL/sqlSetup");

async function createHome({ name, timezone, createdBy }) {
  const db = await poolPromise;
  const r = await db
    .request()
    .input("n", sql.VarChar, name)
    .input("tz", sql.VarChar, timezone || "Africa/Cairo")
    .input("u", sql.Int, createdBy).query(`
      INSERT INTO Homes(name, timezone, created_by) OUTPUT inserted.id
      VALUES(@n, @tz, @u)
    `);
  const homeId = r.recordset[0].id;
  await db
    .request()
    .input("h", sql.Int, homeId)
    .input("u", sql.Int, createdBy)
    .input("r", sql.VarChar, "owner")
    .query("INSERT INTO HomeMembers(home_id, user_id, role) VALUES(@h,@u,@r)");
  return homeId;
}

async function addMember({ homeId, userId, role, guestExpiresAt = null }) {
  const db = await poolPromise;
  await db
    .request()
    .input("h", sql.Int, homeId)
    .input("u", sql.Int, userId)
    .input("r", sql.VarChar, role)
    .input("gx", sql.DateTime2, guestExpiresAt).query(`
      MERGE HomeMembers AS t
      USING (SELECT @h AS home_id, @u AS user_id) s
      ON (t.home_id=s.home_id AND t.user_id=s.user_id)
      WHEN MATCHED THEN UPDATE SET role=@r, guest_expires_at=@gx
      WHEN NOT MATCHED THEN INSERT(home_id,user_id,role,guest_expires_at) VALUES(@h,@u,@r,@gx);
    `);
}

async function listHomesForUser(userId) {
  const db = await poolPromise;
  const r = await db.request().input("u", sql.Int, userId).query(`
      SELECT h.id, h.name, h.timezone, m.role
      FROM Homes h
      JOIN HomeMembers m ON m.home_id = h.id
      WHERE m.user_id = @u
      ORDER BY h.id DESC
    `);
  return r.recordset;
}

module.exports = { createHome, addMember, listHomesForUser };
