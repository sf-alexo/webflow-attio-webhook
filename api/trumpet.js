/**
 * SendTrumpet (trumpet) webhook receiver.
 * Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * Matches Companies in Attio by "SendTrumpet Pod URL" containing the pod ID
 * (uses the first match if several), updates "Last Pod Activity", and creates
 * a Person for the viewer email only when that email does not already exist.
 */

// Attio attribute slugs on Companies
const ATTIO_POD_URL_ATTRIBUTE = "sendtrumpet_pod_url";
const ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE = "last_pod_activity";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function normalizeViewerEmail(viewer) {
  if (!viewer || typeof viewer !== "string") return null;
  const email = viewer.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
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

async function findPersonByEmail(apiKey, email) {
  const response = await fetch(
    "https://api.attio.com/v2/objects/people/records/query",
    {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        filter: {
          email_addresses: email,
        },
        limit: 1,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio people query failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  const result = await response.json();
  return result.data?.[0] ?? null;
}

async function createPersonWithCompany(apiKey, email, companyRecordId) {
  const response = await fetch(
    "https://api.attio.com/v2/objects/people/records",
    {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [
              {
                email_address: email,
              },
            ],
            company: [
              {
                target_object: "companies",
                target_record_id: companyRecordId,
              },
            ],
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio people create failed");
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
    const viewerEmail = normalizeViewerEmail(data.viewer);

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
      viewerEmail,
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

    // If multiple Companies match one pod URL, use the first only.
    const company = matches[0] ?? null;

    console.log("Attio company match by SendTrumpet Pod URL", {
      webhookPodId: podId,
      matchCount: matches.length,
      selectedCompany: company,
      matches,
    });

    if (!company) {
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

    let companyUpdated = false;

    try {
      await updateCompanyLastPodActivity(
        apiKey,
        company.recordId,
        activityDate
      );
      companyUpdated = true;
    } catch (error) {
      console.error("Attio company update error:", {
        status: error.status,
        details: error.details,
        recordId: company.recordId,
        attribute: ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE,
      });
    }

    let personResult = {
      action: "skipped",
      reason: "No valid viewer email",
    };

    if (viewerEmail) {
      try {
        const existingPerson = await findPersonByEmail(apiKey, viewerEmail);

        if (existingPerson) {
          personResult = {
            action: "exists",
            recordId: existingPerson.id?.record_id ?? null,
            email: viewerEmail,
          };

          console.log("Attio Person already exists; not creating", personResult);
        } else {
          const created = await createPersonWithCompany(
            apiKey,
            viewerEmail,
            company.recordId
          );

          personResult = {
            action: "created",
            recordId: created.data?.id?.record_id ?? null,
            email: viewerEmail,
            companyRecordId: company.recordId,
          };

          console.log("Attio Person created and linked to Company", personResult);
        }
      } catch (error) {
        console.error("Attio Person lookup/create error:", {
          status: error.status,
          details: error.details,
          email: viewerEmail,
          companyRecordId: company.recordId,
        });

        personResult = {
          action: "error",
          email: viewerEmail,
          error: "Failed to look up or create Person in Attio",
        };
      }
    }

    if (!companyUpdated) {
      return res.status(502).json({
        received: true,
        event: body.event ?? data.type ?? null,
        eventId: body.id ?? null,
        podId,
        companyMatched: true,
        matchCount: matches.length,
        company,
        activityDate,
        companyUpdated: false,
        error: "Failed to update Last Pod Activity date",
        person: personResult,
      });
    }

    return res.status(200).json({
      received: true,
      event: body.event ?? data.type ?? null,
      eventId: body.id ?? null,
      podId,
      companyMatched: true,
      matchCount: matches.length,
      company,
      activityDate,
      companyUpdated: true,
      person: personResult,
    });
  } catch (error) {
    console.error("Trumpet webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
