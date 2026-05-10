module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  if (req.query.caps)   { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, {headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }
  if (req.query.desc)   { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=${req.query.layer||"jupiter_boringer_ws"}`, {headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }
  if (req.query.sample) { const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${req.query.layer||"jupiter_boringer_ws"}&maxFeatures=1`, {headers:hdrs}); res.setHeader("Content-Type","text/xml"); return res.status(r.status).send(await r.text()); }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // Helper: fetch GML from WFS
  const fetchGML = async (typeName, filter) => {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${typeName}&maxFeatures=200&CQL_FILTER=${encodeURIComponent(filter)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      if (!r.ok || t.includes("ExceptionReport") || t.includes("HTTP Status")) return null;
      if (t.includes('numberOfFeatures="0"') || t.includes("numberOfFeatures='0'")) return null;
      if (!t.includes("featureMember")) return null;
      return t;
    } catch(e) { return null; }
  };

  // Helper: extract tag value from GML (strips ms: namespace)
  const g = (xml, tag) => {
    const re = new RegExp(`<ms:${tag}[^>]*>([^<]*)<\/ms:${tag}>`, "i");
    const m  = xml.match(re);
    return m ? m[1].trim() || null : null;
  };

  // Helper: extract all ms: fields as object
  const allFields = (xml) => {
    const out = {};
    const re = /<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g;
    let m;
    while ((m = re.exec(xml)) !== null) out[m[1]] = m[2].trim();
    return out;
  };

  // Helper: extract GML coordinates
  const coords = (xml) => {
    const m = xml.match(/<gml:coordinates[^>]*>([\d., ]+)<\/gml:coordinates>/);
    if (!m) return [null, null];
    const parts = m[1].split(",");
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  };

  // ── Step 1: Fetch boring using exact field name "dgunr" ─────────────────────
  // From sample we know: <ms:dgunr>146.3602</ms:dgunr>
  // DGU format in WFS uses dot notation: "182.218"
  const boringGML = await fetchGML("jupiter_boringer_ws", `dgunr='${dgu}'`);
  if (!boringGML) {
    return res.status(404).json({
      error: `Ingen boring fundet for DGU ${dgu}`,
      tip: "Tjek at DGU-nummeret har korrekt format, f.eks. 182.218"
    });
  }

  const bf   = allFields(boringGML);
  const [utmx, utmy] = coords(boringGML);
  const borid = bf.borid || bf.id;

  // ── Step 2: Fetch cyklogram (litologi) via borid ─────────────────────────────
  // From sample: <ms:cyklogram>https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=612324</ms:cyklogram>
  let litho = [];
  const cykloUrl = bf.cyklogram;
  if (cykloUrl) {
    try {
      const cr = await fetch(cykloUrl, { headers: hdrs, signal: AbortSignal.timeout(8000) });
      const ct = await cr.text();
      // Cyklogram returns HTML or GML - try to extract litologi layers
      if (ct.includes("featureMember")) {
        // It's GML - parse layers
        const layerRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
        let lm;
        while ((lm = layerRe.exec(ct)) !== null) {
          const lf = allFields(lm[1]);
          litho.push({
            fraM:  lf.fra_m || lf.fra || lf.dybde_fra || lf.depth_from,
            tilM:  lf.til_m || lf.til || lf.dybde_til || lf.depth_to,
            tekst: lf.litologi_tekst || lf.tekst || lf.beskrivelse || lf.lithology || lf.symbol_tekst,
            symbol: lf.symbol || lf.lith_symbol,
          });
        }
      } else if (ct.includes("<tr") || ct.includes("<td")) {
        // HTML table - extract rows
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(ct)) !== null) {
          const cells = rm[1].match(/<td[^>]*>([^<]*)<\/td>/gi);
          if (cells && cells.length >= 2) {
            const vals = cells.map(c => c.replace(/<[^>]+>/g, "").trim());
            if (vals[0] && !isNaN(parseFloat(vals[0]))) {
              litho.push({ fraM: vals[0], tilM: vals[1], tekst: vals[2] || vals[3] || null });
            }
          }
        }
      }
    } catch(_) {}
  }

  // Also try WFS layer jupiter_bor_cyklogram with borid
  if (litho.length === 0 && borid) {
    const cykloGML = await fetchGML("jupiter_bor_cyklogram", `borid=${borid}`);
    if (cykloGML) {
      const layerRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
      let lm;
      while ((lm = layerRe.exec(cykloGML)) !== null) {
        const lf = allFields(lm[1]);
        litho.push({
          fraM:  lf.fra_m || lf.fra,
          tilM:  lf.til_m || lf.til,
          tekst: lf.litologi_tekst || lf.tekst || lf.beskrivelse || lf.symbol_tekst,
          symbol: lf.symbol,
        });
      }
    }
  }

  // Sort litho by depth
  litho = litho
    .filter(l => l.fraM != null || l.tekst)
    .sort((a,b) => (parseFloat(a.fraM)||0) - (parseFloat(b.fraM)||0));

  // ── Step 3: Check for PDF borerapport ────────────────────────────────────────
  // From sample: <ms:url>https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=612324</ms:url>
  // This is an HTML page - check if a PDF version exists
  const boreholeUrl = bf.url; // e.g. https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=XXX
  let pdfUrl = null;
  const dguNoDot = dgu.replace(/\./g, "");

  const pdfCandidates = [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu}.pdf`,
    borid ? `https://data.geus.dk/boredokument/${borid}.pdf` : null,
  ].filter(Boolean);

  for (const u of pdfCandidates) {
    try {
      const r = await fetch(u, { method: "HEAD", headers: hdrs, signal: AbortSignal.timeout(4000) });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.toLowerCase().includes("pdf")) { pdfUrl = u; break; }
    } catch(_) {}
  }

  // ── Response ─────────────────────────────────────────────────────────────────
  return res.status(200).json({
    boring: {
      dguNr:        bf.dgunr          || dgu,
      boringsid:    bf.borid          || bf.id,
      navn:         bf.anlaegsnavn    || bf.boringsby || null,
      formaal:      bf.formaal_tekst  || bf.formaal,
      anvendelse:   bf.anvendelse_tekst || bf.anvendelse,
      status:       bf.kode_tekst     || bf.kode,
      boremetode:   bf.broendborer    || null,
      dato:         bf.dato           || bf.aar,
      kommune:      bf.kommunenavn,
      region:       bf.region_tekst   || bf.region,
      adresse:      bf.sted1          || null,
      postnr:       bf.postnr,
      utmx:         utmx              || bf.xutm,
      utmy:         utmy              || bf.yutm,
      kote:         bf.terraen_kote,
      dybde:        bf.dybde_num      || bf.dybde,
      dataejer:     bf.dataejer,
      pdfUrl,
      boreholeUrl,  // HTML borerapport side
      cykloUrl:     bf.cyklogram,
    },
    litho,
    anlaeg: [],
    vandstand: [],
    dgu,
    _meta: { borid, pdfUrl, boreholeUrl, lithoCount: litho.length },
  });
};
