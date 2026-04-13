const WebSocket = require("ws");
const url = require("url");
const { getDb, nextId } = require("../DB/mongo");
const { cleanDocs } = require("../services/mongoData");
const { setCommandStatus } = require("../services/commandStore");

const deviceClients = new Map();
const wss = new WebSocket.Server({ noServer: true });

function attachDeviceWs(server) {
  return setupDeviceWs(server);
}

function parseDeviceId(fullId = "") {
  const noPrefix = fullId.includes(":") ? fullId.split(":")[1] : fullId;
  const [basePart, group_uidRaw] = noPrefix.split("/");
  const group_uid = (group_uidRaw || "").trim();
  const base_id = (basePart || "").trim();
  const tokens = (base_id || "").split("-").filter(Boolean);
  const flags = new Set(
    tokens
      .filter((t) => /^[A-Za-z]+$/.test(t.toUpperCase()))
      .map((t) => t.toUpperCase())
  );
  const pins = tokens
    .filter((t) => /^\d+$/.test(t))
    .map((n) => parseInt(n, 10));
  return { base_id, group_uid, flags, pins };
}

async function ensureLogicalDevices(
  db,
  { fullId, device_secret, home_id, room_id, nickname }
) {
  const { base_id, group_uid, flags, pins } = parseDeviceId(fullId);
  if (!group_uid || !base_id) throw new Error("bad_device_id_format");

  const desired = [];
  if (flags.has("I")) {
    desired.push({ kind: "IR", pin: null, icon: "assets/images/ir.png" });
  }
  if (flags.has("R")) {
    desired.push({
      kind: "RGB",
      pin: null,
      icon: "assets/images/color_wheel_icon.png",
    });
  }

  const sortedPins = [...pins].sort((a, b) => a - b);
  sortedPins.forEach((p, i) =>
    desired.push({
      kind: "SW",
      pin: p,
      swIndex: i + 1,
      icon: "assets/images/switch.png",
    })
  );

  const devices = db.collection("devices");

  for (const d of desired) {
    const typeVal =
      d.kind === "IR" ? "ir" : d.kind === "RGB" ? "rgb" : "switch";

    const nmComputed =
      nickname &&
      (d.kind === "IR"
        ? `${nickname} IR`
        : d.kind === "RGB"
        ? `${nickname} RGB`
        : `${nickname} SW-${d.swIndex || 1}`);

    const nmFallback =
      d.kind === "IR"
        ? `${base_id}-IR`
        : d.kind === "RGB"
        ? `${base_id}-RGB`
        : `${base_id}-SW-${d.swIndex || 1}`;

    const existing = await devices.findOne({
      group_uid,
      kind: d.kind,
      pin: d.pin,
    });

    if (existing) {
      const $set = {};
      if (nmComputed) $set.name = nmComputed;
      if (home_id != null) $set.home_id = home_id;
      if (room_id != null) $set.room_id = room_id;
      if (!existing.icon_path) $set.icon_path = d.icon;
      if (!existing.type) $set.type = typeVal;
      $set.updated_at = new Date();

      await devices.updateOne({ id: existing.id }, { $set });
      continue;
    }

    await devices.insertOne({
      id: await nextId("devices"),
      device_id: fullId,
      device_secret,
      home_id: home_id ?? null,
      room_id: room_id ?? null,
      name: nmComputed || nmFallback,
      base_id,
      group_uid,
      kind: d.kind,
      pin: d.pin,
      icon_path: d.icon,
      type: typeVal,
      meta: JSON.stringify({
        status: "unclaimed",
        first_seen: new Date().toISOString(),
      }),
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  const rows = await devices
    .find(
      { group_uid },
      {
        projection: {
          _id: 0,
          id: 1,
          device_id: 1,
          group_uid: 1,
          base_id: 1,
          kind: 1,
          pin: 1,
          home_id: 1,
          room_id: 1,
          name: 1,
          icon_path: 1,
          type: 1,
        },
      }
    )
    .sort({ kind: 1, pin: 1 })
    .toArray();

  return { base_id, group_uid, devices: cleanDocs(rows) };
}

function setupDeviceWs(server) {
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    } catch {
      try {
        socket.destroy();
      } catch {}
      return;
    }
    if (pathname !== "/ws/device") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  console.log("/ws/device upgrade hook installed");
}

wss.on("connection", async (ws, req) => {
  const q = url.parse(req.url, true).query || {};
  const device_id = q.device_id;
  const device_secret = q.device_secret;
  const home_id = q.home_id ? Number(q.home_id) : null;
  const room_id = q.room_id ? Number(q.room_id) : null;
  const nickname = (q.nickname || "").trim() || null;

  ws.on("error", (err) => console.error("WS error:", err?.message || err));
  ws.on("close", (code, reason) => {
    if (Array.isArray(ws.devicePks)) {
      for (const id of ws.devicePks) {
        if (deviceClients.get(id) === ws) {
          deviceClients.delete(id);
        }
      }
    }
    console.log(
      `WS closed ${device_id || ""}:`,
      code,
      reason?.toString() || ""
    );
  });

  try {
    if (!device_id || !device_secret) {
      ws.close(4401, "missing credentials");
      return;
    }

    const db = await getDb();
    const group = await ensureLogicalDevices(db, {
      fullId: device_id,
      device_secret,
      home_id,
      room_id,
      nickname,
    });

    const ids = group.devices.map((d) => d.id);
    ws.devicePks = ids;
    ids.forEach((id) => deviceClients.set(id, ws));
    const primaryPk = ids[0];
    ws.primaryPk = primaryPk;
    console.log(
      `Device connected: ${device_id} bound to logical ids=${ids.join(",")}`
    );

    try {
      const pending = await db
        .collection("pendingCommands")
        .find(
          { device_id: primaryPk },
          { projection: { _id: 0, id: 1, payload: 1 } }
        )
        .sort({ id: 1 })
        .toArray();

      for (const row of pending) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "control",
              payload: JSON.parse(row.payload),
              msg_id: String(row.id),
            })
          );
        }
      }

      if (pending.length) {
        await db.collection("pendingCommands").deleteMany({
          id: { $in: pending.map((row) => row.id) },
        });
      }
    } catch (e) {
      console.warn("flush pending error:", e?.message || e);
    }

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "ack") {
        const id = Number(msg.msg_id);
        const ok = !!msg.ok;
        const status = ok ? "ack" : "failed";
        const error = ok ? null : msg.error || "device error";
        if (Number.isFinite(id)) {
          try {
            await setCommandStatus(id, status, error);
          } catch {}
        }
      }
    });
  } catch (e) {
    console.error("WS connection error:", e);
    try {
      ws.close(1011, "internal");
    } catch {}
  }
});

console.log("/ws/device ready (nickname/home/room supported)");

module.exports = {
  attachDeviceWs,
  setupDeviceWs,
  deviceClients,
};
