// Vercel serverless function — GEUS Jupiter proxy
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX parameter" });

  const base = "https://data.geus.dk/JupiterWWW/api/v1";
  const hdrs = { "Accept": "application/json", "User-Agent": "Awell/1.0" };

  try {
    // 1. Søg efter boring via DGU-nummer
    const s = await fetch(`${base}/boringer?dguNr=${encodeURIComponent(dgu)}`, { headers: hdrs });
    if (!s.ok) return res.status(502).json({ error: `GEUS returnerede HTTP ${s.status}` });
    const raw = await s.json();
    const list = Array.isArray(raw) ? raw : (raw.boringer || raw.results || [raw]);
    if (!list || !list.length || !list[0]) {
      return res.status(404).json({ error: `Ingen boring fundet for DGU ${dgu}` });
    }

    const boring = list[0];
    const id = boring.boringsid || boring.boringId || boring.id;

    // 2. Hent detaljer, litologi og vandstand parallelt
    const get = (url) => fetch(url, { headers: hdrs }).then(r => r.ok ? r.json() : null).catch(() => null);
    const [detail, lithoRaw, vandRaw] = await Promise.all([
      id ? get(`${base}/boringer/${id}`) : null,
      id ? get(`${base}/boringer/${id}/loglitologi`) : null,
      id ? get(`${base}/boringer/${id}/vandstand`) : null,
    ]);

    const norm = (v, key) => v == null ? [] : Array.isArray(v) ? v : (v[key] || []);

    res.status(200).json({
      boring: detail || boring,
      litho: norm(lithoRaw, "litologi"),
      vandstand: norm(vandRaw, "vandstand"),
      dgu,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
