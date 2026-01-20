const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || "";

function isValidZoomToken(req) {
  const auth = (req.headers.authorization || req.headers.Authorization || "").trim();
  if (!auth) return false;
  const supplied = auth.replace(/^Bearer\s+/i, "");
  return supplied === ZOOM_WEBHOOK_SECRET;
}

exports.handleZoomWebhook = async (req, res) => {
  try {
    const validationToken =
      req.query?.validationToken || req.body?.plain?.validationToken || req.body?.validationToken;

    if (validationToken) {
      res.set("content-type", "text/plain");
      return res.status(200).send(validationToken);
    }

    if (!isValidZoomToken(req)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid Zoom webhook token" });
    }

    const event = req.body;
    console.log("Zoom webhook event received:", JSON.stringify(event));

    // TODO: handle specific events (meeting.started / ended / participant joined etc.)

    return res.status(204).end();
  } catch (err) {
    console.error("zoom webhook error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
