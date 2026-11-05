/**
 * SendTrumpet (trumpet) webhook receiver.
 * Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * Receiver-only for now — logs a safe summary and returns 200.
 * Does not verify Trumpet-Signature yet and does not call Attio.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    const data = body.data ?? {};

    console.log("Trumpet webhook received", {
      eventId: body.id,
      event: body.event ?? data.type,
      created: body.created,
      apiVersion: body.api_version,
      podId: data.pod,
      content: data.content,
      viewer: data.viewer ?? null,
      crmType: data.crm?.type ?? null,
      crmObject: data.crm?.object ?? null,
      contextKeys: Object.keys(data.context ?? {}),
      signatureHeader: Boolean(
        req.headers["trumpet-signature"] ?? req.headers["Trumpet-Signature"]
      ),
    });

    return res.status(200).json({
      received: true,
      event: body.event ?? data.type ?? null,
      eventId: body.id ?? null,
    });
  } catch (error) {
    console.error("Trumpet webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
