const sql = require("mssql");

const config = {
  user: "myuser", 
  password: "StrongP@ss123", 
  server: "localhost", // 
  database: "SmartHomeDB",
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("✅ Connected to MSSQL");
    return pool;
  })
  .catch((err) => {
    console.error("❌ MSSQL Connection Failed:", err);
  });

module.exports = {
  sql,
  poolPromise,
};
