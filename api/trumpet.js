/**
 * Combined webhook endpoint: POST /api/trumpet
 *
 * A) SendTrumpet engagement → Attio Company/Person/Notes
 *    Docs: https://www.sendtrumpet.app/docs/webhooks
 *
 * B) Attio record.created (Companies) → create SendTrumpet Pod
 *    "{Company Name} <> Accton", then set sendtrumpet_pod_url
 *
 * Point both SendTrumpet and Attio webhooks at this same URL.
 * Payload shape decides which path runs.
 *
 * Extra env for (B): TRUMPET_API_KEY, TRUMPET_TEMPLATE_ID,
 * optional TRUMPET_OWNER_EMAIL, TRUMPET_POD_NAME_SUFFIX
 */

// Attio attribute slugs on Companies
const ATTIO_POD_URL_ATTRIBUTE = "sendtrumpet_pod_url";
const ATTIO_LAST_POD_ACTIVITY_ATTRIBUTE = "last_pod_activity";
const POD_NAME_SUFFIX =
  process.env.TRUMPET_POD_NAME_SUFFIX?.trim() || " <> Accton";

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

function splitPersonName(fullName) {
  const name = fullName?.trim();
  if (!name) return null;

  const parts = name.split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ") || firstName;

  return {
    first_name: firstName,
    last_name: lastName,
    full_name: name,
  };
}

/**
 * Trumpet Insights shows enriched viewer names; webhooks only document
 * data.viewer (email). data.context is undocumented and may include a name
 * under common keys — walk objects/arrays and pick the first usable value.
 */
function extractViewerNameFromContext(context) {
  if (context == null) return null;

  const NAME_KEYS = [
    "name",
    "full_name",
    "fullName",
    "viewer_name",
    "viewerName",
    "display_name",
    "displayName",
    "first_name",
    "firstName",
  ];

  const seen = new WeakSet();

  function fromObject(obj) {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return null;
    seen.add(obj);

    const first =
      typeof obj.first_name === "string"
        ? obj.first_name
        : typeof obj.firstName === "string"
          ? obj.firstName
          : null;
    const last =
      typeof obj.last_name === "string"
        ? obj.last_name
        : typeof obj.lastName === "string"
          ? obj.lastName
          : null;

    if (first && last) {
      return `${first.trim()} ${last.trim()}`.trim();
    }

    for (const key of NAME_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.trim() && !value.includes("@")) {
        return value.trim();
      }
    }

    for (const value of Object.values(obj)) {
      const nested = walk(value);
      if (nested) return nested;
    }

    return null;
  }

  function walk(value) {
    if (value == null) return null;
    if (typeof value === "string") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      return fromObject(value);
    }
    return null;
  }

  return walk(context);
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

async function createPersonWithCompany(apiKey, email, companyRecordId, fullName) {
  const values = {
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
  };

  const name = splitPersonName(fullName);
  if (name) {
    values.name = [name];
  }

  const response = await fetch(
    "https://api.attio.com/v2/objects/people/records",
    {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: { values },
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

function isAttioWebhookPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.webhook_id === "string") return true;
  if (Array.isArray(body.events)) return true;
  if (typeof body.event_type === "string") return true;
  return false;
}

function extractAttioEvents(body) {
  if (Array.isArray(body.events)) return body.events;
  if (body.event_type) return [body];
  return [];
}

function companyNameFromRecord(record) {
  const nameValues = record?.values?.name;
  if (!Array.isArray(nameValues) || nameValues.length === 0) return null;

  const first = nameValues[0];
  return (
    first?.value?.trim?.() ||
    first?.full_name?.trim?.() ||
    (typeof first === "string" ? first.trim() : null) ||
    null
  );
}

function existingPodUrlFromRecord(record) {
  const values = record?.values?.[ATTIO_POD_URL_ATTRIBUTE];
  if (!Array.isArray(values) || values.length === 0) return null;
  const first = values[0];
  return (
    first?.value?.trim?.() ||
    (typeof first === "string" ? first.trim() : null) ||
    null
  );
}

function buildPodTitle(companyName) {
  const base = companyName?.trim() || "Untitled Company";
  return `${base}${POD_NAME_SUFFIX}`;
}

async function getCompanyRecord(apiKey, recordId) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/companies/records/${recordId}`,
    {
      method: "GET",
      headers: attioHeaders(apiKey),
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio get company failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  const result = await response.json();
  return result.data ?? null;
}

async function updateCompanyPodUrl(apiKey, recordId, liveUrl) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/companies/records/${recordId}`,
    {
      method: "PATCH",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            [ATTIO_POD_URL_ATTRIBUTE]: liveUrl,
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio update company pod URL failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  return response.json();
}

/**
 * Prefer ObjectId-based live URL for Attio matching.
 * Engagement webhooks send data.pod as ObjectId; Trumpet's live_url may use a UUID.
 */
function buildMatchablePodUrl(podId, liveUrl) {
  const hostOverride = process.env.TRUMPET_POD_HOST?.replace(/\/$/, "");

  let origin = hostOverride || "https://trumpet.app";
  if (!hostOverride && liveUrl) {
    try {
      origin = new URL(liveUrl).origin;
    } catch {
      // keep default
    }
  }

  if (podId) {
    return `${origin}/pods/${podId}/live`;
  }

  return liveUrl || null;
}

async function createTrumpetPod({
  apiKey,
  templateId,
  title,
  companyName,
  ownerEmail,
}) {
  const baseBody = {
    template_id: templateId,
  };

  if (ownerEmail) {
    baseBody.owner_email = ownerEmail;
  }

  async function post(body) {
    const response = await fetch("https://trumpet.app/api/v1/pods/new", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return { response, text, json };
  }

  // Zapier exposes Title + Recipient Company; REST docs omit them.
  // Try likely field names without creating duplicate Pods (stop on first 2xx).
  const namingAttempts = [
    {
      title,
      name: title,
      pod_name: title,
      podName: title,
      recipient_company: companyName || title,
      recipientCompany: companyName || title,
    },
    { title, name: title, pod_name: title },
    { title },
    { name: title },
    { pod_name: title },
    { podName: title },
    { recipient_company: companyName || title },
    {},
  ];

  let lastFailure = null;

  for (const naming of namingAttempts) {
    const body = { ...baseBody, ...naming };
    const result = await post(body);

    if (result.response.ok) {
      console.log("Trumpet Create Pod succeeded", {
        requestedTitle: title,
        namingFieldsUsed: Object.keys(naming),
        podId: result.json?.data?.id ?? null,
        liveUrl: result.json?.data?.live_url ?? null,
      });

      return {
        ...result.json,
        requestedTitle: title,
        namingFieldsUsed: Object.keys(naming),
      };
    }

    lastFailure = result;
    console.warn("Trumpet Create Pod attempt failed; trying next naming shape", {
      namingFields: Object.keys(naming),
      status: result.response.status,
      details: result.text,
    });
  }

  const error = new Error("Trumpet create pod failed");
  error.status = lastFailure?.response?.status;
  error.details = lastFailure?.text;
  throw error;
}

async function provisionPodForCompany(attioApiKey, trumpetConfig, recordId) {
  const company = await getCompanyRecord(attioApiKey, recordId);

  if (!company) {
    return {
      action: "ignored",
      reason: "Record is not a Company (or not found)",
      recordId,
    };
  }

  const companyName = companyNameFromRecord(company);
  const podUrl = existingPodUrlFromRecord(company);

  if (podUrl) {
    return {
      action: "skipped",
      reason: "sendtrumpet_pod_url already set",
      recordId,
      companyName,
      podUrl,
    };
  }

  const title = buildPodTitle(companyName);

  const created = await createTrumpetPod({
    apiKey: trumpetConfig.apiKey,
    templateId: trumpetConfig.templateId,
    title,
    companyName,
    ownerEmail: trumpetConfig.ownerEmail,
  });

  const apiLiveUrl = created?.data?.live_url ?? null;
  const podId = created?.data?.id ?? null;
  const matchablePodUrl = buildMatchablePodUrl(podId, apiLiveUrl);

  if (!matchablePodUrl) {
    const error = new Error("Trumpet create pod returned no pod id/live_url");
    error.details = JSON.stringify(created);
    throw error;
  }

  await updateCompanyPodUrl(attioApiKey, recordId, matchablePodUrl);

  return {
    action: "provisioned",
    recordId,
    companyName,
    podTitle: title,
    namingFieldsUsed: created.namingFieldsUsed ?? [],
    podId,
    apiLiveUrl,
    matchablePodUrl,
  };
}

async function handleAttioCompanyCreated(res, body) {
  const attioApiKey = process.env.ATTIO_API_KEY;
  const trumpetApiKey = process.env.TRUMPET_API_KEY;
  const templateId = process.env.TRUMPET_TEMPLATE_ID;
  const ownerEmail = process.env.TRUMPET_OWNER_EMAIL || null;

  if (!attioApiKey) {
    console.error("ATTIO_API_KEY is missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (!trumpetApiKey || !templateId) {
    console.error("TRUMPET_API_KEY or TRUMPET_TEMPLATE_ID is missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const trumpetConfig = {
    apiKey: trumpetApiKey,
    templateId,
    ownerEmail,
  };

  const events = extractAttioEvents(body);

  console.log("Attio company webhook received", {
    eventCount: events.length,
    eventTypes: events.map((e) => e.event_type),
    recordIds: events.map((e) => e.id?.record_id),
  });

  const results = [];

  for (const event of events) {
    if (event.event_type !== "record.created") {
      results.push({
        action: "ignored",
        reason: "Not record.created",
        eventType: event.event_type ?? null,
      });
      continue;
    }

    const recordId = event.id?.record_id;
    if (!recordId) {
      results.push({
        action: "ignored",
        reason: "Missing record_id",
      });
      continue;
    }

    try {
      const result = await provisionPodForCompany(
        attioApiKey,
        trumpetConfig,
        recordId
      );
      results.push(result);
      console.log("Attio → Trumpet provision result", result);
    } catch (error) {
      console.error("Attio → Trumpet provision failed", {
        recordId,
        status: error.status,
        details: error.details,
        message: error.message,
      });

      results.push({
        action: "error",
        recordId,
        error: error.message,
        details: error.details ?? null,
      });
    }
  }

  const hasHardError = results.some((r) => r.action === "error");

  return res.status(hasHardError ? 502 : 200).json({
    received: true,
    source: "attio",
    results,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    // Always log first so we can see whether Attio/Trumpet reached this function.
    console.log("Incoming /api/trumpet request", {
      method: req.method,
      contentType: req.headers["content-type"] ?? null,
      hasAttioSignature: Boolean(
        req.headers["attio-signature"] ?? req.headers["x-attio-signature"]
      ),
      hasTrumpetSignature: Boolean(
        req.headers["trumpet-signature"] ?? req.headers["Trumpet-Signature"]
      ),
      bodyType: body === null ? "null" : typeof body,
      bodyKeys:
        body && typeof body === "object" ? Object.keys(body).slice(0, 20) : [],
      isAttioShape: isAttioWebhookPayload(body),
    });

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    // Attio company-created → provision SendTrumpet Pod
    if (isAttioWebhookPayload(body)) {
      return handleAttioCompanyCreated(res, body);
    }

    const data = body.data ?? {};
    const podId = data.pod ?? null;
    const event = body.event ?? data.type ?? null;
    const activityDate = activityDateFromWebhook(body.created);
    const viewerEmail = normalizeViewerEmail(data.viewer);
    const viewerName = extractViewerNameFromContext(data.context);
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
      viewerName,
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
            company.recordId,
            viewerName
          );

          personResult = {
            action: "created",
            recordId: created.data?.id?.record_id ?? null,
            email: viewerEmail,
            name: viewerName ?? null,
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
