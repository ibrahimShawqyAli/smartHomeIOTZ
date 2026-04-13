const WebSocket = require("ws");
const { getDb, nextId } = require("../DB/mongo");
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
  console.log("/ws/app upgrade hook installed (NO AUTH)");
}

appWss.on("connection", async (ws, req) => {
  ws.on("error", (e) => console.error("WS app error:", e?.message || e));
  console.log("App WS connected from", req.socket?.remoteAddress || "unknown");
  ws.send(JSON.stringify({ type: "hello" }));

  ws.on("message", async (raw) => {
    const txt = raw.toString();
    console.log("[/ws/app] raw:", txt);

    let msg;
    try {
      msg = JSON.parse(txt);
    } catch (e) {
      console.warn("[/ws/app] JSON parse error:", e?.message || e);
      ws.send(JSON.stringify({ type: "error", code: "BAD_JSON" }));
      return;
    }

    console.log("[/ws/app] parsed:", msg);

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      return;
    }

    if (msg.type !== "control") {
      console.warn("[/ws/app] unknown type:", msg.type);
      ws.send(JSON.stringify({ type: "error", code: "UNKNOWN_TYPE" }));
      return;
    }

    const devicePk = Number(msg.device_pk);
    console.log("[/ws/app] control target pk=", devicePk, "payload=", msg.payload);

    if (!Number.isFinite(devicePk) || devicePk <= 0) {
      console.warn("[/ws/app] invalid device_pk:", msg.device_pk);
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
      const db = await getDb();
      const payload = msg.payload || {};
      const deviceWs = deviceClients.get(devicePk);

      if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
        console.log("[/ws/app] LIVE send to device_pk", devicePk, payload);
        deviceWs.send(JSON.stringify({ type: "control", payload }));
        ws.send(
          JSON.stringify({ type: "queued", device_pk: devicePk, live: true })
        );
        return;
      }

      console.log("[/ws/app] QUEUE send to device_pk", devicePk, payload);
      const cmdId = await nextId("pendingCommands");
      await db.collection("pendingCommands").insertOne({
        id: cmdId,
        device_id: devicePk,
        payload: JSON.stringify(payload),
        created_at: new Date(),
        expire_at: new Date(Date.now() + 10 * 60 * 1000),
      });

      ws.send(
        JSON.stringify({
          type: "queued",
          device_pk: devicePk,
          live: false,
          cmd_id: cmdId,
        })
      );
    } catch (e) {
      console.error("[/ws/app] control error:", e);
      ws.send(JSON.stringify({ type: "error", code: "INTERNAL" }));
    }
  });
});

module.exports = { attachAppWs };
