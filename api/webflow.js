const ATTIO_POSITION_LINK = "state-of-analytics-in-the-age-of-ai";
const ATTIO_POSITION_NAME = "State of Analytics in the Age of AI";
const IRM_POSITION_LINK = "irm-uk-2026-london-november";
const ATTIO_GTM_SIGNAL_OBJECT = "gtm_signals";
const GTM_SIGNAL_SOURCE = "website";
const GTM_SIGNAL_LEVEL = "person";
const GTM_SIGNAL_TYPE = "webinar registration";

const IRM_EVENT = {
  label: "IRM",
  signalNamePrefix:
    "requested recordings - IRM UK 2026 London registration",
  signalCampaign: "2026-11 IRM UK Conference",
  personCompanyCampaign: "2026-03 IRM UK",
};

const SUMMIT_EVENT = {
  label: "Summit",
  signalNamePrefix:
    "requested recordings - State of Analytics in the Age of AI registration",
  signalCampaign: "2026-10 SUMMIT",
  personCompanyCampaign: "2026-10 SUMMIT",
};

function attioHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function companyRecordIdFromPerson(person) {
  const companyValues = person?.values?.company;
  if (!Array.isArray(companyValues) || companyValues.length === 0) {
    return null;
  }

  return companyValues[0]?.target_record_id ?? null;
}

function emailDomain(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
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

async function getPersonById(apiKey, recordId) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/people/records/${recordId}`,
    {
      method: "GET",
      headers: attioHeaders(apiKey),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio get person failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  const result = await response.json();
  return result.data ?? null;
}

async function resolvePersonWithCompany(apiKey, person, { retries = 3 } = {}) {
  if (!person?.id?.record_id) return person;

  let current = person;
  if (companyRecordIdFromPerson(current)) {
    return current;
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }

    try {
      current = (await getPersonById(apiKey, person.id.record_id)) ?? current;
    } catch (error) {
      console.warn("Attio person refresh for company failed", {
        status: error.status,
        details: error.details,
        recordId: person.id.record_id,
        attempt,
      });
      break;
    }

    if (companyRecordIdFromPerson(current)) {
      return current;
    }
  }

  return current;
}

async function createPerson(apiKey, { email, name, campaign }) {
  const values = {
    email_addresses: [
      {
        email_address: email,
      },
    ],
  };

  if (campaign) {
    values.campaign = [{ option: campaign }];
  }

  if (name) {
    const parts = name.split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(" ") || firstName;

    values.name = [
      {
        first_name: firstName,
        last_name: lastName,
        full_name: name,
      },
    ];
  }

  // Explicitly link/create Company by email domain so the relationship
  // is available before we create the GTM Signal.
  const domain = emailDomain(email);
  if (domain) {
    values.company = [
      {
        target_object: "companies",
        target_record_reference: {
          match: {
            domains: [{ domain }],
          },
          if_unmatched: "create",
          if_multiple_matches: "error",
          create: {
            name: domain,
            domains: [{ domain }],
          },
        },
      },
    ];
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

  const result = await response.json();
  return result.data ?? null;
}

async function findGtmSignalByName(apiKey, signalName) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/${ATTIO_GTM_SIGNAL_OBJECT}/records/query`,
    {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        filter: {
          name: signalName,
        },
        limit: 1,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error("Attio GTM Signal query failed");
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  const result = await response.json();
  return result.data?.[0] ?? null;
}

async function appendCampaign(apiKey, objectSlug, recordId, campaign) {
  const response = await fetch(
    `https://api.attio.com/v2/objects/${objectSlug}/records/${recordId}`,
    {
      method: "PATCH",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            // PATCH prepends multiselect values.
            campaign: [{ option: campaign }],
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Attio ${objectSlug} campaign update failed`);
    error.status = response.status;
    error.details = errorText;
    throw error;
  }

  return response.json();
}

async function appendCampaignToPersonAndCompany(
  apiKey,
  personRecordId,
  companyRecordId,
  campaign
) {
  const result = {
    personCampaignUpdated: false,
    companyCampaignUpdated: false,
  };

  try {
    await appendCampaign(apiKey, "people", personRecordId, campaign);
    result.personCampaignUpdated = true;
  } catch (error) {
    console.error("Attio Person campaign update error:", {
      status: error.status,
      details: error.details,
      personRecordId,
      campaign,
    });
  }

  if (companyRecordId) {
    try {
      await appendCampaign(apiKey, "companies", companyRecordId, campaign);
      result.companyCampaignUpdated = true;
    } catch (error) {
      console.error("Attio Company campaign update error:", {
        status: error.status,
        details: error.details,
        companyRecordId,
        campaign,
      });
    }
  }

  return result;
}

async function createRegistrationGtmSignal(res, formData, apiKey, event) {
  const email = formData.Email?.trim().toLowerCase();
  const name = formData.Name?.trim();
  const {
    label,
    signalNamePrefix,
    signalCampaign,
    personCompanyCampaign,
  } = event;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "A valid email is required",
    });
  }

  const signalName = `${signalNamePrefix} - ${email}`;

  let person;
  let personCreated = false;
  try {
    person = await findPersonByEmail(apiKey, email);
  } catch (error) {
    console.error("Attio query error:", {
      status: error.status,
      details: error.details,
      email,
    });

    return res.status(502).json({
      error: "Failed to look up Person in Attio",
    });
  }

  if (!person) {
    try {
      person = await createPerson(apiKey, {
        email,
        name,
        campaign: personCompanyCampaign,
      });
      personCreated = true;

      console.log(`Attio Person created for ${label} registration`, {
        recordId: person?.id?.record_id ?? null,
        email,
        name: name ?? null,
        campaign: personCompanyCampaign,
      });
    } catch (error) {
      console.error("Attio Person create error:", {
        status: error.status,
        details: error.details,
        email,
      });

      return res.status(502).json({
        error: "Failed to create Person in Attio",
      });
    }
  }

  if (!person) {
    return res.status(502).json({
      error: "Failed to create Person in Attio",
      email,
    });
  }

  // Attio may attach Company just after Person create; refresh before Signal.
  person = await resolvePersonWithCompany(apiKey, person);

  const personRecordId = person.id?.record_id;
  const companyRecordId = companyRecordIdFromPerson(person);

  let campaignUpdates = {
    personCampaignUpdated: personCreated,
    companyCampaignUpdated: false,
    personCreated,
  };

  if (personCreated) {
    // Person already got campaign on create; still update Company if linked.
    if (companyRecordId) {
      try {
        await appendCampaign(
          apiKey,
          "companies",
          companyRecordId,
          personCompanyCampaign
        );
        campaignUpdates.companyCampaignUpdated = true;
      } catch (error) {
        console.error("Attio Company campaign update error:", {
          status: error.status,
          details: error.details,
          companyRecordId,
          campaign: personCompanyCampaign,
        });
      }
    }
  } else {
    campaignUpdates = {
      ...(await appendCampaignToPersonAndCompany(
        apiKey,
        personRecordId,
        companyRecordId,
        personCompanyCampaign
      )),
      personCreated: false,
    };
  }

  console.log(`${label} person/company resolved for GTM Signal`, {
    personRecordId,
    companyRecordId,
    personCreated,
  });

  let existingSignal;
  try {
    existingSignal = await findGtmSignalByName(apiKey, signalName);
  } catch (error) {
    console.error("Attio GTM Signal query error:", {
      status: error.status,
      details: error.details,
      signalName,
    });

    return res.status(502).json({
      error: "Failed to look up GTM Signal in Attio",
      ...campaignUpdates,
    });
  }

  if (existingSignal) {
    const recordId = existingSignal.id?.record_id ?? null;

    console.log("Attio GTM Signal already exists; skipping create", {
      recordId,
      name: signalName,
      ...campaignUpdates,
    });

    return res.status(200).json({
      success: true,
      gtmSignalCreated: false,
      alreadyExists: true,
      recordId,
      name: signalName,
      personCampaign: personCompanyCampaign,
      ...campaignUpdates,
    });
  }

  const createdAt = new Date().toISOString();

  const values = {
    name: signalName,
    source: { option: GTM_SIGNAL_SOURCE },
    level: { option: GTM_SIGNAL_LEVEL },
    signal_type: { option: GTM_SIGNAL_TYPE },
    campaign: signalCampaign,
    occurred_at: createdAt,
    person: [
      {
        target_object: "people",
        target_record_id: personRecordId,
      },
    ],
  };

  if (companyRecordId) {
    values.company = [
      {
        target_object: "companies",
        target_record_id: companyRecordId,
      },
    ];
  }

  const response = await fetch(
    `https://api.attio.com/v2/objects/${ATTIO_GTM_SIGNAL_OBJECT}/records`,
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

    console.error("Attio GTM Signal create error:", {
      status: response.status,
      details: errorText,
      signalName,
      personRecordId,
      companyRecordId,
    });

    return res.status(502).json({
      error: "Failed to create GTM Signal in Attio",
      ...campaignUpdates,
    });
  }

  const result = await response.json();

  console.log("Attio GTM Signal created", {
    recordId: result.data?.id?.record_id,
    name: signalName,
    source: GTM_SIGNAL_SOURCE,
    level: GTM_SIGNAL_LEVEL,
    signalType: GTM_SIGNAL_TYPE,
    campaign: signalCampaign,
    personCampaign: personCompanyCampaign,
    occurredAt: createdAt,
    personRecordId,
    companyRecordId,
    ...campaignUpdates,
  });

  return res.status(200).json({
    success: true,
    gtmSignalCreated: true,
    name: signalName,
    source: GTM_SIGNAL_SOURCE,
    level: GTM_SIGNAL_LEVEL,
    signalType: GTM_SIGNAL_TYPE,
    campaign: signalCampaign,
    personCampaign: personCompanyCampaign,
    occurredAt: createdAt,
    personRecordId,
    companyRecordId,
    ...campaignUpdates,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;
    const payload = body?.payload ?? body;
    const formData = payload?.data ?? {};
    const positionLink = formData.position_link;
    const positionName = formData.position_name;

    console.log("Webflow submission context:", {
      formName: payload?.name,
      siteId: payload?.siteId,
      positionName,
      positionLink,
      pageUrl: formData.page_url,
      submittedAt: payload?.submittedAt,
    });

    if (payload?.name !== "Registration-events-Form") {
      return res.status(200).json({ ignored: true });
    }

    const apiKey = process.env.ATTIO_API_KEY;

    if (!apiKey) {
      console.error("ATTIO_API_KEY is missing");
      return res.status(500).json({
        error: "Server configuration error",
      });
    }

    if (positionLink === IRM_POSITION_LINK) {
      return createRegistrationGtmSignal(res, formData, apiKey, IRM_EVENT);
    }

    const shouldRunSummitAttio =
      positionLink === ATTIO_POSITION_LINK ||
      positionName === ATTIO_POSITION_NAME;

    if (!shouldRunSummitAttio) {
      return res.status(200).json({
        received: true,
        attioSkipped: true,
        reason: "position not enabled for Attio",
        positionLink: positionLink ?? null,
        positionName: positionName ?? null,
      });
    }

    return createRegistrationGtmSignal(res, formData, apiKey, SUMMIT_EVENT);
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
