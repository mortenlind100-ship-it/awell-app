module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  if (req.query.ping) {
    try {
      const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      return res.status(200).json({ ok: r.ok, status: r.status });
    } catch(e) { return res.status(200).json({ error: e.message }); }
  }

  if (req.query.sample) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${layer}&maxFeatures=1`, { headers: hdrs });
    res.setHeader("Content-Type","text/xml");
    return res.status(r.status).send(await r.text());
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const g = (xml, tag) => {
    const m = xml.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i"));
    return m ? m[1].trim() || null : null;
  };
  const allFields = (xml) => {
    const out = {};
    const re = /<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g;
    let m;
    while ((m = re.exec(xml)) !== null) out[m[1]] = m[2].trim();
    return out;
  };
  const coords = (xml) => {
    const m = xml.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/);
    if (!m) return [null, null];
    const p = m[1].split(",");
    return [parseFloat(p[0]), parseFloat(p[1])];
  };
  const fetchRaw = async (url, timeoutMs = 20000) => {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(timeoutMs) });
      const t = await r.text();
      return { ok: r.ok, status: r.status, text: t };
    } catch(e) { return { ok: false, error: e.message }; }
  };

  // ── Parse DGU: "182.218" → lo=182.217, hi=182.219 (±0.001 window) ──────────
  // This tiny window will only ever contain the exact boring we want
  const dguFloat = parseFloat(dgu);
  if (isNaN(dguFloat)) return res.status(400).json({ error: `Ugyldigt DGU format: ${dgu}` });

  const lo = (dguFloat - 0.0005).toFixed(4);
  const hi = (dguFloat + 0.0005).toFixed(4);

  const searchUrl = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
    + `&typeName=jupiter_boringer_ws&maxFeatures=10`
    + `&CQL_FILTER=${encodeURIComponent(`dgunr BETWEEN ${lo} AND ${hi}`)}`;

  const raw = await fetchRaw(searchUrl, 20000);

  if (!raw.ok) {
    return res.status(502).json({ error: "GEUS WFS fejl: " + (raw.error || raw.status), url: searchUrl });
  }
  if (raw.text.includes("ExceptionReport") || raw.text.includes("HTTP Status")) {
    return res.status(502).json({ error: "GEUS WFS exception", preview: raw.text.slice(0, 300) });
  }

  // Find the feature whose dgunr string exactly matches
  const featureRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
  let fm;
  let boringXML = null;
  const candidates = [];

  while ((fm = featureRe.exec(raw.text)) !== null) {
    const fxml    = fm[1];
    const fDgu    = g(fxml, "dgunr") || "";
    const fDguOrg = (g(fxml, "dgunr_org") || "").replace(/\.\s+/, ".").trim();
    candidates.push(fDgu);
    if (fDgu === dgu || fDguOrg === dgu) { boringXML = fxml; break; }
  }

  // If no exact match in tight window, the decimal part might have more digits
  // e.g. stored as "182.2180" — normalise and retry
  if (!boringXML && candidates.length > 0) {
    // Just take the closest one — within ±0.0005 there should only be one boring
    const featureRe2 = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
    const fm2 = featureRe2.exec(raw.text);
    if (fm2) boringXML = fm2[1];
  }

  if (!boringXML) {
    return res.status(404).json({
      error: `Ingen boring fundet for DGU ${dgu}`,
      searchWindow: `${lo} – ${hi}`,
      candidates,
    });
  }

  const bf   = allFields(boringXML);
  const [utmx, utmy] = coords(boringXML);
  const borid    = bf.borid || bf.id;
  const cykloUrl = bf.cyklogram;

  // ── Litologi ─────────────────────────────────────────────────────────────────
  let litho = [];
  if (cykloUrl) {
    try {
      const cr = await fetch(cykloUrl, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const ct = await cr.text();
      if (ct.includes("featureMember")) {
        const re = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
        let lm;
        while ((lm = re.exec(ct)) !== null) {
          const lf = allFields(lm[1]);
          litho.push({
            fraM:   lf.fra_m  || lf.fra,
            tilM:   lf.til_m  || lf.til,
            tekst:  lf.litologi_tekst || lf.tekst || lf.beskrivelse || lf.symbol_tekst,
            symbol: lf.symbol,
          });
        }
      } else if (ct.includes("<td")) {
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(ct)) !== null) {
          const cells = rm[1].match(/<td[^>]*>([^<]*)<\/td>/gi);
          if (cells && cells.length >= 2) {
            const vals = cells.map(c => c.replace(/<[^>]+>/g,"").trim());
            if (vals[0] && !isNaN(parseFloat(vals[0])))
              litho.push({ fraM: vals[0], tilM: vals[1], tekst: vals[2]||null });
          }
        }
      }
    } catch(_) {}
  }
  litho = litho
    .filter(l => l.fraM || l.tekst)
    .sort((a,b) => (parseFloat(a.fraM)||0) - (parseFloat(b.fraM)||0));

  // ── PDF ──────────────────────────────────────────────────────────────────────
  let pdfUrl = null;
  const dguNoDot = dgu.replace(/\./g,"");
  for (const u of [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
  ].filter(Boolean)) {
    try {
      const r = await fetch(u, { method:"HEAD", headers:hdrs, signal:AbortSignal.timeout(4000) });
      if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf"))
        { pdfUrl = u; break; }
    } catch(_) {}
  }

  return res.status(200).json({
    boring: {
      dguNr:      bf.dgunr     || dgu,
      boringsid:  borid,
      formaal:    bf.formaal_tekst   || bf.formaal,
      anvendelse: bf.anvendelse_tekst || bf.anvendelse,
      status:     bf.kode_tekst      || bf.kode,
      boremetode: bf.broendborer,
      dato:       bf.dato || bf.aar,
      kommune:    bf.kommunenavn,
      region:     bf.region_tekst,
      adresse:    bf.sted1,
      postnr:     bf.postnr,
      utmx:       utmx || parseFloat(bf.xutm),
      utmy:       utmy || parseFloat(bf.yutm),
      kote:       bf.terraen_kote,
      dybde:      bf.dybde_num || bf.dybde,
      dataejer:   bf.dataejer,
      pdfUrl,
      boreholeUrl: bf.url,
      cykloUrl,
    },
    litho, anlaeg:[], vandstand:[], dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, searchWindow: `${lo}–${hi}`, candidates },
  });
};
