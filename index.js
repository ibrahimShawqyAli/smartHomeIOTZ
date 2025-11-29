// index.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");

// REST routes
const membersRoutes = require("./API/members");
const authRoutes = require("./API/auth");
const devicesRoutes = require("./API/devices");
const schedulesRoutes = require("./API/schedule");
const homeRoutes = require("./API/homes");
const roomRoutes = require("./API/rooms");
const meRoutes = require("./API/me");

// Schedulers / WS attachers
const { startSchedulePolling } = require("./trigger/trigger");
const { attachDeviceWs } = require("./WS/websocket"); // must export attachDeviceWs
const { attachAppWs } = require("./WS/appWs"); // must export attachAppWs

const app = express();
const server = http.createServer(app);

// ---- Middleware ----
app.use(cors({ origin: "*" }));
app.use(express.json());

// Optional: simple health check (handy during WS debugging)
app.get("/", (_req, res) => res.status(200).send("OK"));

// ---- REST ----
app.use("/auth", authRoutes);
app.use("/devices", devicesRoutes);
app.use("/schedules", schedulesRoutes);
app.use("/homes", homeRoutes);
app.use("/rooms", roomRoutes);
app.use("/homes-invitation", membersRoutes);
app.use(meRoutes);

// Centralized duplicate-key guard + fallback
app.use((err, _req, res, _next) => {
  if (err && (err.number === 2627 || err.number === 2601)) {
    return res.status(409).json({ message: "Duplicate key" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "internal error" });
});

// ---- WebSockets (deterministic routing) ----
// IMPORTANT: both WS servers should be created with { noServer: true } and
// expose attachDeviceWs/attachAppWs which listen to server 'upgrade' and route by pathname.
attachDeviceWs(server);
attachAppWs(server);

// (Optional) debug: see incoming upgrades
server.on("upgrade", (req) => {
  console.log("UPGRADE", req.url, req.headers.upgrade, req.headers.connection);
});

// ---- Background jobs ----
startSchedulePolling();

// ---- Listen ----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`HTTP + WebSocket on :${PORT}`);
});
