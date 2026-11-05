/**
 * SendTrumpet (trumpet) webhook receiver.
 * Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * Matches Companies in Attio by "SendTrumpet Pod URL" containing the pod ID,
 * then updates "Last Pod Activity date".
 */

// Attio attribute slugs on Companies
const ATTIO_POD_URL_ATTRIBUTE = "sendtrumpet_pod_url";
const ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE = "last_pod_activity";

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

function activityDateFromWebhook(created) {
  const date =
    typeof created === "number" && Number.isFinite(created)
      ? new Date(created * 1000)
      : new Date();

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  // Attio date attrs accept ISO and trim time; timestamp attrs keep full value.
  return date.toISOString();
}

function attioHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function findCompanyByPodId(apiKey, podId) {
  const response = await fetch(
    "https://api.attio.com/v2/objects/companies/records/query",
    {
      method: "POST",
      headers: attioHeaders(apiKey),
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

async function updateCompanyLastPodActivity(apiKey, recordId, activityDate) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/companies/records/${recordId}`,
    {
      method: "PATCH",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            [ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE]: activityDate,
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio company update failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  return response.json();
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
    const activityDate = activityDateFromWebhook(body.created);

    console.log("Trumpet webhook received", {
      eventId: body.id,
      event: body.event ?? data.type,
      created: body.created,
      activityDate,
      apiVersion: body.api_version,
      podId,
      expectedLiveUrlHint: podId ? `…/pods/${podId}/live` : null,
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

    if (matches.length === 0) {
      return res.status(200).json({
        received: true,
        event: body.event ?? data.type ?? null,
        eventId: body.id ?? null,
        podId,
        companyMatched: false,
        matchCount: 0,
        matches: [],
      });
    }

    const updates = [];

    for (const match of matches) {
      try {
        await updateCompanyLastPodActivity(
          apiKey,
          match.recordId,
          activityDate
        );

        updates.push({
          recordId: match.recordId,
          name: match.name,
          updated: true,
          lastPodActivityDate: activityDate,
        });
      } catch (error) {
        console.error("Attio company update error:", {
          status: error.status,
          details: error.details,
          recordId: match.recordId,
          attribute: ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE,
        });

        updates.push({
          recordId: match.recordId,
          name: match.name,
          updated: false,
          error: "Failed to update Last Pod Activity date",
        });
      }
    }

    console.log("Attio Last Pod Activity date updates", {
      activityDate,
      updates,
    });

    const anyUpdated = updates.some((u) => u.updated);

    return res.status(anyUpdated ? 200 : 502).json({
      received: true,
      event: body.event ?? data.type ?? null,
      eventId: body.id ?? null,
      podId,
      companyMatched: true,
      matchCount: matches.length,
      activityDate,
      updates,
    });
  } catch (error) {
    console.error("Trumpet webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
