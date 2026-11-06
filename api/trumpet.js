/**
 * SendTrumpet (trumpet) webhook receiver.
 * Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * Matches Companies in Attio by "SendTrumpet Pod URL" containing the pod ID
 * (uses the first match if several), updates "Last Pod Activity", creates a
 * Person for new viewer emails, and writes engagement Notes on the Company.
 */

// Attio attribute slugs on Companies
const ATTIO_POD_URL_ATTRIBUTE = "sendtrumpet_pod_url";
const ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE = "last_pod_activity";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOTE_EVENTS = new Set([
  "event.pod_is_viewed",
  "event.file_downloaded",
]);

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

/**
 * Best-effort pod name from Trumpet's human-readable content string.
 * Examples:
 *   "aperez@… opened 2026-10 State of Analytics - 1"
 *   "ayopergipergi@… downloaded file.pdf in 2026-10 State of Analytics - 1"
 */
function extractPodNameFromContent(content) {
  if (!content || typeof content !== "string") return null;

  const opened = content.match(/\sopened\s+(.+)$/i);
  if (opened?.[1]) return opened[1].trim();

  const downloadedIn = content.match(/\sin\s+(.+)$/i);
  if (downloadedIn?.[1]) return downloadedIn[1].trim();

  return null;
}

function buildCompanyNote(event, content) {
  const summary = typeof content === "string" ? content.trim() : "";
  const podName = extractPodNameFromContent(summary);
  const podLine = podName ? `Pod:${podName}` : null;

  if (event === "event.pod_is_viewed") {
    const body = [
      summary ? `New view - ${summary}` : "New view",
      podLine,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      title: "New view",
      content: body,
    };
  }

  if (event === "event.file_downloaded") {
    const body = [summary, podLine].filter(Boolean).join("\n");

    return {
      title: "File downloaded",
      content: body || "File downloaded",
    };
  }

  return null;
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

async function createCompanyNote(apiKey, companyRecordId, note, createdAt) {
  const payload = {
    parent_object: "companies",
    parent_record_id: companyRecordId,
    title: note.title,
    format: "plaintext",
    content: note.content,
  };

  if (createdAt) {
    payload.created_at = createdAt;
  }

  const response = await fetch("https://api.attio.com/v2/notes", {
    method: "POST",
    headers: attioHeaders(apiKey),
    body: JSON.stringify({
      data: payload,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio note create failed");
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
    const event = body.event ?? data.type ?? null;
    const activityDate = activityDateFromWebhook(body.created);
    const viewerEmail = normalizeViewerEmail(data.viewer);
    const notePayload = NOTE_EVENTS.has(event)
      ? buildCompanyNote(event, data.content)
      : null;

    console.log("Trumpet webhook received", {
      eventId: body.id,
      event,
      created: body.created,
      activityDate,
      apiVersion: body.api_version,
      podId,
      expectedLiveUrlHint: podId ? `…/pods/${podId}/live` : null,
      content: data.content,
      viewer: data.viewer ?? null,
      viewerEmail,
      notePayload,
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

    let noteResult = {
      action: "skipped",
      reason: notePayload
        ? null
        : "Event type not configured for Company notes",
    };

    if (notePayload) {
      try {
        const createdNote = await createCompanyNote(
          apiKey,
          company.recordId,
          notePayload,
          activityDate
        );

        noteResult = {
          action: "created",
          noteId: createdNote.data?.id?.note_id ?? null,
          title: notePayload.title,
          content: notePayload.content,
        };

        console.log("Attio Company note created", noteResult);
      } catch (error) {
        console.error("Attio Company note create error:", {
          status: error.status,
          details: error.details,
          companyRecordId: company.recordId,
          notePayload,
        });

        noteResult = {
          action: "error",
          title: notePayload.title,
          error: "Failed to create Company note in Attio",
        };
      }
    }

    if (!companyUpdated) {
      return res.status(502).json({
        received: true,
        event,
        eventId: body.id ?? null,
        podId,
        companyMatched: true,
        matchCount: matches.length,
        company,
        activityDate,
        companyUpdated: false,
        error: "Failed to update Last Pod Activity date",
        person: personResult,
        note: noteResult,
      });
    }

    return res.status(200).json({
      received: true,
      event,
      eventId: body.id ?? null,
      podId,
      companyMatched: true,
      matchCount: matches.length,
      company,
      activityDate,
      companyUpdated: true,
      person: personResult,
      note: noteResult,
    });
  } catch (error) {
    console.error("Trumpet webhook processing failed", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
