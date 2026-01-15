const { WebSocketServer } = require("ws");
const tokenService = require("./tokenService");

let wss = null;
const clientsByUserId = new Map();
const clientsByRole = new Map();

function removeClient(userId, role, ws) {
  if (userId && clientsByUserId.has(userId)) {
    const set = clientsByUserId.get(userId);
    set.delete(ws);
    if (set.size === 0) clientsByUserId.delete(userId);
  }
  if (role && clientsByRole.has(role)) {
    const set = clientsByRole.get(role);
    set.delete(ws);
    if (set.size === 0) clientsByRole.delete(role);
  }
}

function init(server) {
  if (wss) return wss;

  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const verification = tokenService.verifyAccessToken(token || "");
      if (!verification.valid) {
        ws.close();
        return;
      }

      const userId = String(verification.decoded.userId);
      const role = String(verification.decoded.role || "");

      if (!clientsByUserId.has(userId)) clientsByUserId.set(userId, new Set());
      clientsByUserId.get(userId).add(ws);

      if (role) {
        if (!clientsByRole.has(role)) clientsByRole.set(role, new Set());
        clientsByRole.get(role).add(ws);
      }

      ws.on("close", () => removeClient(userId, role, ws));
      ws.on("error", () => removeClient(userId, role, ws));
    } catch (_) {
      ws.close();
    }
  });

  return wss;
}

function sendToUser(userId, payload) {
  const set = clientsByUserId.get(String(userId));
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function sendToRole(role, payload) {
  const set = clientsByRole.get(String(role));
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

module.exports = { init, sendToUser, sendToRole };
