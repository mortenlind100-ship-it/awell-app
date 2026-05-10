// Vercel serverless function — proxies GEUS Jupiter API (avoids browser CORS restriction)
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { dgu } = req.query;
  if (!dgu) return res.status(400).json({ error: "dgu parameter mangler" });

  const base = "https://data.geus.dk/JupiterWWW/api/v1";

  try {
    // Step 1: find boring by DGU number
    const sRes = await fetch(`${base}/boringer?dguNr=${encodeURIComponent(dgu)}`, {
      headers: { Accept: "application/json", "User-Agent": "Awell-App/1.0" }
    });
    if (!sRes.ok) throw new Error(`GEUS svarede med HTTP ${sRes.status}`);
    const sData = await sRes.json();

    const list = Array.isArray(sData) ? sData : (sData.boringer || sData.results || []);
    if (!list.length) return res.status(404).json({ error: `Ingen boring fundet for DGU ${dgu}` });

    const boring = list[0];
    const id = boring.boringsid || boring.boringId || boring.id;

    // Step 2: parallel fetch of detail + litologi + vandstand
    const headers = { Accept: "application/json", "User-Agent": "Awell-App/1.0" };
    const [dR, lR, vR] = await Promise.allSettled([
      id ? fetch(`${base}/boringer/${id}`,             { headers }) : Promise.reject("no id"),
      id ? fetch(`${base}/boringer/${id}/loglitologi`, { headers }) : Promise.reject("no id"),
      id ? fetch(`${base}/boringer/${id}/vandstand`,   { headers }) : Promise.reject("no id"),
    ]);

    const detail    = dR.status==="fulfilled" && dR.value.ok ? await dR.value.json() : boring;
    const lithoRaw  = lR.status==="fulfilled" && lR.value.ok ? await lR.value.json() : [];
    const vandRaw   = vR.status==="fulfilled" && vR.value.ok ? await vR.value.json() : [];

    return res.status(200).json({
      boring: detail,
      litho: Array.isArray(lithoRaw) ? lithoRaw : (lithoRaw.litologi || []),
      vandstand: Array.isArray(vandRaw) ? vandRaw : (vandRaw.vandstand || []),
      dgu,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
