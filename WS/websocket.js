const WebSocket = require("ws");
const url = require("url");
const { sql, poolPromise } = require("../SQL/sqlSetup");
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
  if (flags.has("I"))
    desired.push({ kind: "IR", pin: null, icon: "assets/images/ir.png" });
  if (flags.has("R"))
    desired.push({
      kind: "RGB",
      pin: null,
      icon: "assets/images/color_wheel_icon.png",
    });

  const sortedPins = [...pins].sort((a, b) => a - b);
  sortedPins.forEach((p, i) =>
    desired.push({
      kind: "SW",
      pin: p,
      swIndex: i + 1,
      icon: "assets/images/switch.png",
    })
  );

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

    const nmInsert = nmComputed || nmFallback;

    const upd = await db
      .request()
      .input("g", sql.VarChar, group_uid)
      .input("k", sql.VarChar, d.kind)
      .input("p", sql.Int, d.pin)
      .input("nm", sql.NVarChar, nmComputed || null)
      .input("hid", sql.Int, home_id ?? null)
      .input("rid", sql.Int, room_id ?? null)
      .input("icon", sql.VarChar, d.icon)
      .input("typ", sql.VarChar, typeVal).query(`
        UPDATE dbo.Devices
           SET name      = COALESCE(@nm, name),
               home_id   = COALESCE(@hid, home_id),
               room_id   = COALESCE(@rid, room_id),
               icon_path = COALESCE(NULLIF(icon_path,''), @icon),
               type      = COALESCE(NULLIF(type,''), @typ)
         WHERE group_uid = @g
           AND kind      = @k
           AND ((@k <> 'SW' AND pin IS NULL) OR (@k = 'SW' AND pin = @p));
        SELECT @@ROWCOUNT AS n;
      `);

    if ((upd.recordset[0]?.n || 0) === 0) {
      await db
        .request()
        .input("device_id", sql.VarChar, fullId)
        .input("sec", sql.VarChar, device_secret)
        .input("hid", sql.Int, home_id ?? null)
        .input("rid", sql.Int, room_id ?? null)
        .input("nm", sql.NVarChar, nmInsert)
        .input("base", sql.VarChar, base_id)
        .input("grp", sql.VarChar, group_uid)
        .input("k", sql.VarChar, d.kind)
        .input("p", sql.Int, d.pin)
        .input("icon", sql.VarChar, d.icon)
        .input("typ", sql.VarChar, typeVal)
        .input(
          "meta",
          sql.NVarChar,
          JSON.stringify({
            status: "unclaimed",
            first_seen: new Date().toISOString(),
          })
        ).query(`
          INSERT INTO dbo.Devices
            (device_id, device_secret, home_id, room_id, name, base_id, group_uid, kind, pin, icon_path, type, meta, is_active)
          VALUES
            (@device_id, @sec, @hid, @rid, @nm, @base, @grp, @k, @p, @icon, @typ, @meta, 1);
        `);
    }
  }

  const rows = await db.request().input("g", sql.VarChar, group_uid).query(`
      SELECT id, device_id, group_uid, base_id, kind, pin, home_id, room_id, name, icon_path, type
      FROM dbo.Devices
      WHERE group_uid=@g
      ORDER BY kind, pin;
    `);

  return { base_id, group_uid, devices: rows.recordset };
}

function setupDeviceWs(server) {
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    } catch (e) {
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

  console.log("✅ /ws/device upgrade hook installed");
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

    const db = await poolPromise;

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
      `✅ Device connected: ${device_id} → bound to logical ids=${ids.join(
        ","
      )}`
    );

    try {
      const pend = await db
        .request()
        .input("d", sql.Int, primaryPk)
        .query(
          "SELECT id, payload FROM dbo.PendingCommands WHERE device_id=@d ORDER BY id"
        );

      for (const row of pend.recordset) {
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
      await db
        .request()
        .input("d", sql.Int, primaryPk)
        .query("DELETE FROM dbo.PendingCommands WHERE device_id=@d");
    } catch (e) {
      console.warn("flush pending (single) error:", e?.message || e);
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

      if (msg.type === "shadow") {
      }
    });
  } catch (e) {
    console.error("WS connection error:", e);
    try {
      ws.close(1011, "internal");
    } catch {}
  }
});

console.log("✅ /ws/device ready (nickname/home/room supported)");

module.exports = {
  attachDeviceWs,
  setupDeviceWs,
  deviceClients,
};
