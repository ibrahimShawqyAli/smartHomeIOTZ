// appWs.js
const WebSocket = require("ws");
const { sql, poolPromise } = require("../SQL/sqlSetup");
const { deviceClients } = require("./websocket");

const appWss = new WebSocket.Server({ noServer: true });

function attachAppWs(server) {
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== "/ws/app") return;
    appWss.handleUpgrade(req, socket, head, (ws) =>
      appWss.emit("connection", ws, req)
    );
  });
  console.log("✅ /ws/app upgrade hook installed (NO AUTH)");
}

appWss.on("connection", async (ws, req) => {
  ws.on("error", (e) => console.error("WS app error:", e?.message || e));
  console.log(
    "✅ App WS connected from",
    req.socket?.remoteAddress || "unknown"
  );
  ws.send(JSON.stringify({ type: "hello" }));

  ws.on("message", async (raw) => {
    // 1) Log the raw message text exactly as received
    const txt = raw.toString();
    console.log("📩 [/ws/app] raw:", txt);

    // 2) Try to parse JSON, log parse errors
    let msg;
    try {
      msg = JSON.parse(txt);
    } catch (e) {
      console.warn("⚠️ [/ws/app] JSON parse error:", e?.message || e);
      ws.send(JSON.stringify({ type: "error", code: "BAD_JSON" }));
      return;
    }

    // 3) Log parsed envelope
    console.log("🧾 [/ws/app] parsed:", msg);

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      return;
    }

    if (msg.type === "control") {
      const devicePk = Number(msg.device_pk);
      console.log(
        "🎯 [/ws/app] control target pk=",
        devicePk,
        "payload=",
        msg.payload
      );

      if (!Number.isFinite(devicePk) || devicePk <= 0) {
        console.warn("⚠️ [/ws/app] invalid device_pk:", msg.device_pk);
        ws.send(
          JSON.stringify({
            type: "error",
            code: "INVALID_TARGET",
            detail: "device_pk must be a positive integer",
          })
        );
        return;
      }

      try {
        const db = await poolPromise;
        const payload = msg.payload || {};
        const deviceWs = deviceClients.get(devicePk);

        if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
          // 4) Log live route
          console.log(
            "🚀 [/ws/app] LIVE send → device_pk",
            devicePk,
            "payload=",
            payload
          );
          deviceWs.send(JSON.stringify({ type: "control", payload }));
          ws.send(
            JSON.stringify({ type: "queued", device_pk: devicePk, live: true })
          );
        } else {
          // 5) Log queued route
          console.log(
            "⏳ [/ws/app] QUEUE send (device offline) → device_pk",
            devicePk,
            "payload=",
            payload
          );
          const ins = await db
            .request()
            .input("d", sql.Int, devicePk)
            .input("p", sql.NVarChar, JSON.stringify(payload)).query(`
              INSERT INTO PendingCommands(device_id, payload, created_at)
              OUTPUT inserted.id
              VALUES(@d, @p, SYSUTCDATETIME())
            `);

          const cmdId = ins.recordset[0]?.id;
          console.log(
            "✅ [/ws/app] queued cmd_id=",
            cmdId,
            "device_pk=",
            devicePk
          );
          ws.send(
            JSON.stringify({
              type: "queued",
              device_pk: devicePk,
              live: false,
              cmd_id: cmdId,
            })
          );
        }
      } catch (e) {
        console.error("❌ [/ws/app] control error:", e);
        ws.send(JSON.stringify({ type: "error", code: "INTERNAL" }));
      }
    } else {
      // 6) Unknown type
      console.warn("⚠️ [/ws/app] unknown type:", msg.type);
      ws.send(JSON.stringify({ type: "error", code: "UNKNOWN_TYPE" }));
    }
  });
});

module.exports = { attachAppWs };
