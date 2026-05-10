// Vercel serverless function — GEUS Jupiter proxy
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX parameter" });

  const hdrs = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };
  const base = "https://data.geus.dk/JupiterWWW/api/v1";

  // Try multiple DGU number formats
  // Jupiter uses format: {area}.{number} e.g. "182.218"  
  // Sometimes prefixed with county: "4.182.218"
  const dguFormats = [
    dgu,                              // as-is: 182.218
    dgu.replace(".", "%2E"),          // URL-encoded dot
    dgu.split(".").join("%2F"),       // slashes
  ];

  // Try multiple endpoint patterns
  const endpoints = [
    (d) => `${base}/boringer?dguNr=${d}`,
    (d) => `${base}/boringer?DGUNr=${d}`,
    (d) => `${base}/boringer?dgUnr=${d}`,
    (d) => `${base}/boringer?dgu=${d}`,
    (d) => `${base}/boringer/${d}`,
    (d) => `${base}/boringer?search=${d}`,
  ];

  const attempts = [];
  let found = null;

  for (const ep of endpoints) {
    for (const fmt of dguFormats.slice(0, 1)) { // only try as-is first
      const url = ep(encodeURIComponent(fmt));
      try {
        const r = await fetch(url, { headers: hdrs });
        const body = await r.text();
        attempts.push({ url, status: r.status, body: body.slice(0, 100) });
        if (r.ok) {
          try {
            const parsed = JSON.parse(body);
            const list = Array.isArray(parsed) ? parsed : (parsed.boringer || parsed.results || [parsed]);
            if (list && list.length && list[0] && Object.keys(list[0]).length > 2) {
              found = { list, url };
              break;
            }
          } catch(_) {}
        }
      } catch(e) {
        attempts.push({ url, error: e.message });
      }
    }
    if (found) break;
  }

  // If nothing worked, return diagnostic info
  if (!found) {
    return res.status(502).json({
      error: `Ingen fungerende Jupiter endpoint fundet for DGU ${dgu}`,
      attempts: attempts.slice(0, 6),
    });
  }

  const boring = found.list[0];
  const id = boring.boringsid || boring.boringId || boring.id || boring.BoringId;

  const get = async (url) => {
    try {
      const r = await fetch(url, { headers: hdrs });
      return r.ok ? r.json() : null;
    } catch(_) { return null; }
  };

  const [detail, lithoRaw, vandRaw] = await Promise.all([
    id ? get(`${base}/boringer/${id}`) : null,
    id ? get(`${base}/boringer/${id}/loglitologi`) : null,
    id ? get(`${base}/boringer/${id}/vandstand`) : null,
  ]);

  const norm = (v, key) => !v ? [] : Array.isArray(v) ? v : (v[key] || []);

  res.status(200).json({
    boring: detail || boring,
    litho: norm(lithoRaw, "litologi"),
    vandstand: norm(vandRaw, "vandstand"),
    dgu,
    _debug: { foundUrl: found.url, boringId: id },
  });
};
