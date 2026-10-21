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

    const values = {
      email_addresses: [
        {
          email_address: email,
        },
      ],

      // Append this campaign without removing existing campaigns.
      campaign: [
        { option: "2026-10 SUMMIT" },
      ],
    };

    if (name) {
      const parts = name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(" ") || firstName;
    
      values.name = [{
        first_name: firstName,
        last_name: lastName,
        full_name: name.trim(),
      }];
    }

    const response = await fetch(
      "https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          data: { values },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Attio API error:", {
        status: response.status,
        details: errorText,
      });

      return res.status(502).json({
        error: "Failed to save Person in Attio",
      });
    }

    const result = await response.json();

    console.log("Attio Person saved", {
      recordId: result.data?.id?.record_id,
    });

    return res.status(200).json({
      success: true,
      personSaved: true,
      campaign: "026-10 SUMMIT",
    });
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
