export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  console.log("Webhook signature headers present:", {
    timestamp: Boolean(req.headers["x-webflow-timestamp"]),
    signature: Boolean(req.headers["x-webflow-signature"]),
  });

  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({
        error: "Invalid JSON payload",
      });
    }

    const payload = body.payload ?? body;
    const formName = payload.name;

    console.log("Webflow webhook received", {
      triggerType: body.triggerType,
      formName,
      formId: payload.formId ?? payload._id,
      submittedAt: payload.submittedAt ?? payload.d,
      fields: Object.keys(payload.data ?? {}),
    });

    if (
      formName &&
      formName !== "Registration-events-Form"
    ) {
      return res.status(200).json({
        received: true,
        ignored: true,
      });
    }

    return res.status(200).json({
      received: true,
      formName,
    });
  } catch (error) {
    console.error("Webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
