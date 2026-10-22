const CAMPAIGN = "2026-10 SUMMIT";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;
    const payload = body?.payload ?? body;

    if (payload?.name !== "Registration-events-Form") {
      return res.status(200).json({ ignored: true });
    }

    const formData = payload.data ?? {};

    const email = formData.Email?.trim().toLowerCase();
    const name = formData.Name?.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "A valid email is required",
      });
    }

    const apiKey = process.env.ATTIO_API_KEY;

    if (!apiKey) {
      console.error("ATTIO_API_KEY is missing");
      return res.status(500).json({
        error: "Server configuration error",
      });
    }

    const attioHeaders = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const queryResponse = await fetch(
      "https://api.attio.com/v2/objects/people/records/query",
      {
        method: "POST",
        headers: attioHeaders,
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
          headers: attioHeaders,
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

      response = await fetch(
        "https://api.attio.com/v2/objects/people/records",
        {
          method: "POST",
          headers: attioHeaders,
          body: JSON.stringify({
            data: { values },
          }),
        }
      );
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
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
