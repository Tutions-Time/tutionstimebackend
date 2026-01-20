const crypto = require("crypto");

const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || "";

function buildEncryptedToken(plainToken) {
  return crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
    .update(plainToken)
    .digest("hex");
}

exports.handleZoomWebhook = async (req, res) => {
  try {
    const eventBody = req.body || {};

    if (eventBody?.event === "endpoint.url_validation") {
      const plainToken = eventBody.payload?.plainToken;
      if (!plainToken) {
        return res
          .status(400)
          .json({ success: false, message: "Missing plainToken" });
      }

      const encryptedToken = buildEncryptedToken(plainToken);
      return res.status(200).json({ plainToken, encryptedToken });
    }

    console.log("Zoom webhook event:", eventBody.event || "unknown");
    console.log("Webhook payload:", JSON.stringify(eventBody));

    return res.sendStatus(200);
  } catch (err) {
    console.error("zoom webhook error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
