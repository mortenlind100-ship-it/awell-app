module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  if (req.query.caps)   { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`,{headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }
  if (req.query.desc)   { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=${req.query.layer||"jupiter_boringer_ws"}`,{headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }
  if (req.query.sample) { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${req.query.layer||"jupiter_boringer_ws"}&maxFeatures=1`,{headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // Helper: extract ms: tag value
  const g = (xml, tag) => {
    const m = xml.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i"));
    return m ? m[1].trim() || null : null;
  };

  // Helper: all ms: fields as object
  const allFields = (xml) => {
    const out = {};
    const re = /<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g;
    let m;
    while ((m = re.exec(xml)) !== null) out[m[1]] = m[2].trim();
    return out;
  };

  // Helper: GML point coordinates
  const coords = (xml) => {
    const m = xml.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/);
    if (!m) return [null, null];
    const p = m[1].split(",");
    return [parseFloat(p[0]), parseFloat(p[1])];
  };

  // Helper: raw WFS fetch returning GML text or null
  const fetchGML = async (typeName, params) => {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${typeName}&maxFeatures=10&${params}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      if (!r.ok || t.includes("ExceptionReport") || t.includes("HTTP Status")) return null;
      if (!t.includes("featureMember")) return null;
      if (t.includes('numberOfFeatures="0"') || t.includes("numberOfFeatures='0'")) return null;
      return t;
    } catch(e) { return null; }
  };

  // ── Search strategies ────────────────────────────────────────────────────────
  // From GML sample: txt_search = "146.3602 Vandforsyningsboring Sløjfet/opgivet bor ukendt"
  // txt_search starts with dgunr followed by a space — use LIKE '182.218 %' for exact match

  const attempts = [];
  let boringGML = null;

  const strategies = [
    // Best: txt_search starts with DGU + space (guarantees exact number match)
    `CQL_FILTER=${encodeURIComponent(`txt_search LIKE '${dgu} %'`)}`,
    // Also try with leading zero variants or slight format differences
    `CQL_FILTER=${encodeURIComponent(`txt_search LIKE '${dgu}%'`)}`,
    // dgunr_org has format "182. 218" (with space after dot) - try both
    `CQL_FILTER=${encodeURIComponent(`dgunr_org LIKE '${dgu.replace(".", ". ")}%'`)}`,
    `CQL_FILTER=${encodeURIComponent(`dgunr_org = '${dgu}'`)}`,
    // strConcat trick: filter where dgunr matches as string exactly
    `CQL_FILTER=${encodeURIComponent(`strConcat(dgunr,'') = '${dgu}'`)}`,
  ];

  for (const params of strategies) {
    const label = params.split("=").slice(0,2).join("=").slice(-50);
    const gml = await fetchGML("jupiter_boringer_ws", params);
    if (gml) {
      // Verify the returned dgunr actually matches
      const returnedDgu = g(gml, "dgunr") || "";
      const match = returnedDgu === dgu;
      attempts.push({ params: label, returnedDgu, match });
      if (match) { boringGML = gml; break; }
      // If not matching, keep trying
    } else {
      attempts.push({ params: label, result: "ingen resultater" });
    }
  }

  if (!boringGML) {
    return res.status(404).json({
      error: `Ingen præcis match fundet for DGU ${dgu}`,
      hint: "Bekræft at DGU-nummeret er korrekt. Format: 182.218",
      attempts,
    });
  }

  const bf   = allFields(boringGML);
  const [utmx, utmy] = coords(boringGML);
  const borid = bf.borid || bf.id;
  const cykloUrl = bf.cyklogram;
  const boreholeUrl = bf.url;

  // ── Litologi via cyklogram URL ───────────────────────────────────────────────
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
            fraM:  lf.fra_m || lf.fra || lf.dybde_fra,
            tilM:  lf.til_m || lf.til || lf.dybde_til,
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
            const vals = cells.map(c => c.replace(/<[^>]+>/g, "").trim());
            if (vals[0] && !isNaN(parseFloat(vals[0]))) {
              litho.push({ fraM: vals[0], tilM: vals[1], tekst: vals[2] || null });
            }
          }
        }
      }
    } catch(_) {}
  }

  litho = litho
    .filter(l => l.fraM != null || l.tekst)
    .sort((a, b) => (parseFloat(a.fraM) || 0) - (parseFloat(b.fraM) || 0));

  // ── PDF check ───────────────────────────────────────────────────────────────
  let pdfUrl = null;
  const dguNoDot = dgu.replace(/\./g, "");
  for (const u of [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu}.pdf`,
  ].filter(Boolean)) {
    try {
      const r = await fetch(u, { method:"HEAD", headers:hdrs, signal:AbortSignal.timeout(4000) });
      if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf")) { pdfUrl = u; break; }
    } catch(_) {}
  }

  return res.status(200).json({
    boring: {
      dguNr:       bf.dgunr       || dgu,
      boringsid:   borid,
      formaal:     bf.formaal_tekst  || bf.formaal,
      anvendelse:  bf.anvendelse_tekst || bf.anvendelse,
      status:      bf.kode_tekst  || bf.kode,
      boremetode:  bf.broendborer,
      dato:        bf.dato        || bf.aar,
      kommune:     bf.kommunenavn,
      region:      bf.region_tekst,
      adresse:     bf.sted1,
      postnr:      bf.postnr,
      utmx:        utmx           || parseFloat(bf.xutm),
      utmy:        utmy           || parseFloat(bf.yutm),
      kote:        bf.terraen_kote,
      dybde:       bf.dybde_num   || bf.dybde,
      dataejer:    bf.dataejer,
      pdfUrl,
      boreholeUrl,
      cykloUrl,
    },
    litho,
    anlaeg: [],
    vandstand: [],
    dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, attempts },
  });
};
