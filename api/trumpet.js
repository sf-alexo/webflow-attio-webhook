/**
 * SendTrumpet (trumpet) webhook receiver.
 * Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * Matches Companies in Attio by "SendTrumpet Pod URL" containing the pod ID.
 * Lookup/logging only for now — no Company updates yet.
 */

// Attio attribute slug for Companies → "SendTrumpet Pod URL"
const ATTIO_POD_URL_ATTRIBUTE = "sendtrumpet_pod_url";

/**
 * Extract pod ID from a Trumpet live URL.
 * e.g. https://accton.trumpet.app/pods/0edc084f-4ce1-47eb-9944-ad95b0664a40/live
 *   → 0edc084f-4ce1-47eb-9944-ad95b0664a40
 */
function extractPodIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/pods\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function findCompanyByPodId(apiKey, podId) {
  const response = await fetch(
    "https://api.attio.com/v2/objects/companies/records/query",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        filter: {
          [ATTIO_POD_URL_ATTRIBUTE]: {
            value: {
              $contains: podId,
            },
          },
        },
        limit: 5,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio company query failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  const result = await response.json();
  return result.data ?? [];
}

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
    const podId = data.pod ?? null;

    console.log("Trumpet webhook received", {
      eventId: body.id,
      event: body.event ?? data.type,
      created: body.created,
      apiVersion: body.api_version,
      podId,
      // Expected live URL form for matching Attio "SendTrumpet Pod URL":
      // https://<brand>.trumpet.app/pods/<podId>/live
      expectedLiveUrlHint: podId
        ? `…/pods/${podId}/live`
        : null,
      content: data.content,
      viewer: data.viewer ?? null,
      crmType: data.crm?.type ?? null,
      crmObject: data.crm?.object ?? null,
      crmId: data.crm?.id ?? null,
      context: data.context ?? null,
      signatureHeader: Boolean(
        req.headers["trumpet-signature"] ?? req.headers["Trumpet-Signature"]
      ),
    });

    if (!podId) {
      return res.status(200).json({
        received: true,
        event: body.event ?? data.type ?? null,
        eventId: body.id ?? null,
        companyMatched: false,
        reason: "No pod ID in webhook payload",
      });
    }

    const apiKey = process.env.ATTIO_API_KEY;

    if (!apiKey) {
      console.error("ATTIO_API_KEY is missing");
      return res.status(500).json({
        error: "Server configuration error",
      });
    }

    let companies;
    try {
      companies = await findCompanyByPodId(apiKey, podId);
    } catch (error) {
      console.error("Attio company lookup error:", {
        status: error.status,
        details: error.details,
        podId,
        attribute: ATTIO_POD_URL_ATTRIBUTE,
      });

      return res.status(502).json({
        error: "Failed to look up Company in Attio",
      });
    }

    const matches = companies.map((company) => {
      const values = company.values ?? {};
      const podUrlValue = values[ATTIO_POD_URL_ATTRIBUTE]?.[0]?.value ?? null;
      const name =
        values.name?.[0]?.value ?? values.name?.[0]?.full_name ?? null;

      return {
        recordId: company.id?.record_id,
        name,
        podUrl: podUrlValue,
        podIdFromUrl: extractPodIdFromUrl(podUrlValue),
      };
    });

    console.log("Attio company match by SendTrumpet Pod URL", {
      webhookPodId: podId,
      matchCount: matches.length,
      matches,
    });

    return res.status(200).json({
      received: true,
      event: body.event ?? data.type ?? null,
      eventId: body.id ?? null,
      podId,
      companyMatched: matches.length > 0,
      matchCount: matches.length,
      matches,
    });
  } catch (error) {
    console.error("Trumpet webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
