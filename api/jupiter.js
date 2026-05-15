module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  if (req.query.ping) {
    try {
      const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      return res.status(200).json({ httpStatus: r.status, ok: r.ok, body: (await r.text()).slice(0,200) });
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
  const fetchRaw = async (url) => {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      return { ok: r.ok, status: r.status, text: t };
    } catch(e) { return { ok: false, error: e.message }; }
  };

  // ── Strategy: fetch 50 candidates, filter client-side by exact dgunr ─────────
  // dgunr filter returns "similar" numeric values - fetch a batch and pick exact match
  // We fetch with dgunr filter to get candidates in the right numeric neighbourhood,
  // then verify exact string match in Node.js
  const dguFloat = parseFloat(dgu);
  
  // Fetch up to 50 records around the dgunr value
  const searchUrl = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
    + `&typeName=jupiter_boringer_ws&maxFeatures=50`
    + `&CQL_FILTER=${encodeURIComponent(`dgunr = '${dgu}'`)}`;

  const raw = await fetchRaw(searchUrl);

  if (!raw.ok || !raw.text) {
    return res.status(502).json({ error: "GEUS WFS fejlede: " + (raw.error || raw.status), url: searchUrl.slice(50) });
  }

  if (raw.text.includes("ExceptionReport") || raw.text.includes("HTTP Status")) {
    // CQL failed - try without filter and match by txt_search prefix in response
    const allUrl = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
      + `&typeName=jupiter_boringer_ws&maxFeatures=1000`;
    return res.status(502).json({
      error: "CQL filter fejlede på GEUS server",
      gmlError: raw.text.slice(0, 300),
    });
  }

  // Split into individual featureMembers and find exact dgunr match
  const featureRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
  let fm;
  let boringXML = null;
  const candidates = [];

  while ((fm = featureRe.exec(raw.text)) !== null) {
    const fxml = fm[1];
    const fDgu = g(fxml, "dgunr") || "";
    candidates.push(fDgu);
    // Exact string match
    if (fDgu === dgu) { boringXML = fxml; break; }
  }

  // If no exact match found, the filter returned wrong records
  // Try fetching more broadly using BBOX around Denmark and scan
  if (!boringXML) {
    return res.status(404).json({
      error: `WFS returnerede ${candidates.length} boringer men ingen matchede DGU ${dgu} præcist`,
      candidates,
      hint: "DGU-nummeret kunne ikke verificeres. Prøv ?sample=1 for at se feltformat",
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
            fraM:  lf.fra_m || lf.fra,
            tilM:  lf.til_m || lf.til,
            tekst: lf.litologi_tekst || lf.tekst || lf.beskrivelse || lf.symbol_tekst,
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
            if (vals[0] && !isNaN(parseFloat(vals[0]))) litho.push({ fraM: vals[0], tilM: vals[1], tekst: vals[2]||null });
          }
        }
      }
    } catch(_) {}
  }
  litho = litho.filter(l => l.fraM||l.tekst).sort((a,b) => (parseFloat(a.fraM)||0)-(parseFloat(b.fraM)||0));

  // ── PDF ──────────────────────────────────────────────────────────────────────
  let pdfUrl = null;
  const dguNoDot = dgu.replace(/\./g,"");
  for (const u of [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
  ].filter(Boolean)) {
    try {
      const r = await fetch(u, { method:"HEAD", headers:hdrs, signal:AbortSignal.timeout(4000) });
      if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf")) { pdfUrl = u; break; }
    } catch(_) {}
  }

  return res.status(200).json({
    boring: {
      dguNr: bf.dgunr||dgu, boringsid: borid,
      formaal: bf.formaal_tekst||bf.formaal,
      anvendelse: bf.anvendelse_tekst||bf.anvendelse,
      status: bf.kode_tekst||bf.kode,
      boremetode: bf.broendborer, dato: bf.dato||bf.aar,
      kommune: bf.kommunenavn, region: bf.region_tekst,
      adresse: bf.sted1, postnr: bf.postnr,
      utmx: utmx||parseFloat(bf.xutm), utmy: utmy||parseFloat(bf.yutm),
      kote: bf.terraen_kote, dybde: bf.dybde_num||bf.dybde,
      dataejer: bf.dataejer, pdfUrl,
      boreholeUrl: bf.url, cykloUrl,
    },
    litho, anlaeg:[], vandstand:[], dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, candidatesChecked: candidates.length },
  });
};
