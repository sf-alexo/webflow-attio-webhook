const CAMPAIGN = "2026-10 SUMMIT";
const ATTIO_POSITION_LINK = "state-of-analytics-in-the-age-of-ai";
const ATTIO_POSITION_NAME = "State of Analytics in the Age of AI";
const IRM_POSITION_LINK = "irm-uk-2026-london-november";
const ATTIO_GTM_SIGNAL_OBJECT = "gtm_signals";
const GTM_SIGNAL_SOURCE = "website";
const GTM_SIGNAL_LEVEL = "person";
const GTM_SIGNAL_TYPE = "webinar registration";
const GTM_SIGNAL_CAMPAIGN = "2026-11 IRM UK Conference";
const IRM_PERSON_COMPANY_CAMPAIGN = "2026-03 IRM UK";

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

async function appendIrmCampaignToPersonAndCompany(
  apiKey,
  personRecordId,
  companyRecordId
) {
  const result = {
    personCampaignUpdated: false,
    companyCampaignUpdated: false,
  };

  try {
    await appendCampaign(
      apiKey,
      "people",
      personRecordId,
      IRM_PERSON_COMPANY_CAMPAIGN
    );
    result.personCampaignUpdated = true;
  } catch (error) {
    console.error("Attio Person campaign update error:", {
      status: error.status,
      details: error.details,
      personRecordId,
      campaign: IRM_PERSON_COMPANY_CAMPAIGN,
    });
  }

  if (companyRecordId) {
    try {
      await appendCampaign(
        apiKey,
        "companies",
        companyRecordId,
        IRM_PERSON_COMPANY_CAMPAIGN
      );
      result.companyCampaignUpdated = true;
    } catch (error) {
      console.error("Attio Company campaign update error:", {
        status: error.status,
        details: error.details,
        companyRecordId,
        campaign: IRM_PERSON_COMPANY_CAMPAIGN,
      });
    }
  }

  return result;
}

async function createIrmGtmSignal(res, formData, apiKey) {
  const email = formData.Email?.trim().toLowerCase();
  const name = formData.Name?.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "A valid email is required",
    });
  }

  const signalName = `requested recordings - IRM UK 2026 London registration - ${email}`;

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
        campaign: IRM_PERSON_COMPANY_CAMPAIGN,
      });
      personCreated = true;

      console.log("Attio Person created for IRM registration", {
        recordId: person?.id?.record_id ?? null,
        email,
        name: name ?? null,
        campaign: IRM_PERSON_COMPANY_CAMPAIGN,
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

  const personRecordId = person.id?.record_id;
  const companyRecordId = companyRecordIdFromPerson(person);
  const campaignUpdates = personCreated
    ? {
        personCampaignUpdated: true,
        companyCampaignUpdated: false,
        personCreated: true,
      }
    : {
        ...(await appendIrmCampaignToPersonAndCompany(
          apiKey,
          personRecordId,
          companyRecordId
        )),
        personCreated: false,
      };

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
      personCampaign: IRM_PERSON_COMPANY_CAMPAIGN,
      ...campaignUpdates,
    });
  }

  const createdAt = new Date().toISOString();

  const values = {
    name: signalName,
    source: { option: GTM_SIGNAL_SOURCE },
    level: { option: GTM_SIGNAL_LEVEL },
    signal_type: { option: GTM_SIGNAL_TYPE },
    campaign: GTM_SIGNAL_CAMPAIGN,
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
    campaign: GTM_SIGNAL_CAMPAIGN,
    personCampaign: IRM_PERSON_COMPANY_CAMPAIGN,
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
    campaign: GTM_SIGNAL_CAMPAIGN,
    personCampaign: IRM_PERSON_COMPANY_CAMPAIGN,
    occurredAt: createdAt,
    personRecordId,
    companyRecordId,
    ...campaignUpdates,
  });
}

async function saveSummitPerson(res, formData, apiKey) {
  const email = formData.Email?.trim().toLowerCase();
  const name = formData.Name?.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "A valid email is required",
    });
  }

  const headers = attioHeaders(apiKey);

  const queryResponse = await fetch(
    "https://api.attio.com/v2/objects/people/records/query",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter: {
          email_addresses: email,
        },
        limit: 1,
      }),
    }
  );

  if (!queryResponse.ok) {
    const errorText = await queryResponse.text();

    console.error("Attio query error:", {
      status: queryResponse.status,
      details: errorText,
    });

    return res.status(502).json({
      error: "Failed to look up Person in Attio",
    });
  }

  const queryResult = await queryResponse.json();
  const existingPerson = queryResult.data?.[0];

  let response;
  let created = false;

  if (existingPerson) {
    // Existing person: append campaign only (PATCH prepends multiselect values).
    response = await fetch(
      `https://api.attio.com/v2/objects/people/records/${existingPerson.id.record_id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          data: {
            values: {
              campaign: [{ option: CAMPAIGN }],
            },
          },
        }),
      }
    );
  } else {
    const values = {
      email_addresses: [
        {
          email_address: email,
        },
      ],
      campaign: [{ option: CAMPAIGN }],
    };

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

    response = await fetch("https://api.attio.com/v2/objects/people/records", {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: { values },
      }),
    });
    created = true;
  }

  if (!response.ok) {
    const errorText = await response.text();

    console.error("Attio API error:", {
      status: response.status,
      details: errorText,
      created,
    });

    return res.status(502).json({
      error: created
        ? "Failed to create Person in Attio"
        : "Failed to update campaign in Attio",
    });
  }

  const result = await response.json();

  console.log("Attio Person saved", {
    recordId: result.data?.id?.record_id,
    created,
    campaign: CAMPAIGN,
  });

  return res.status(200).json({
    success: true,
    personSaved: true,
    created,
    campaign: CAMPAIGN,
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
      return createIrmGtmSignal(res, formData, apiKey);
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

    return saveSummitPerson(res, formData, apiKey);
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
