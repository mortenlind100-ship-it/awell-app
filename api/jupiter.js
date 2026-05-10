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

  // Helper: extract ms: field value from GML
  const g = (xml, tag) => {
    const m = xml.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i"));
    return m ? m[1].trim() || null : null;
  };

  // Helper: all ms: fields
  const allFields = (xml) => {
    const out = {};
    const re = /<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g;
    let m;
    while ((m = re.exec(xml)) !== null) out[m[1]] = m[2].trim();
    return out;
  };

  // Helper: GML coordinates
  const coords = (xml) => {
    const m = xml.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/);
    if (!m) return [null, null];
    const p = m[1].split(",");
    return [parseFloat(p[0]), parseFloat(p[1])];
  };

  // Helper: fetch GML with OGC XML filter (more reliable than CQL for exact match)
  const fetchWithXMLFilter = async (typeName, fieldName, value) => {
    const filter = `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc"><ogc:PropertyIsEqualTo matchCase="false"><ogc:PropertyName>${fieldName}</ogc:PropertyName><ogc:Literal>${value}</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>`;
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${typeName}&maxFeatures=5&FILTER=${encodeURIComponent(filter)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      if (!r.ok || t.includes("ExceptionReport") || t.includes("HTTP Status") || !t.includes("featureMember")) return null;
      if (t.includes('numberOfFeatures="0"') || t.includes("numberOfFeatures='0'")) return null;
      return t;
    } catch(e) { return null; }
  };

  // Helper: fetch GML with CQL (fallback)
  const fetchWithCQL = async (typeName, cql) => {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${typeName}&maxFeatures=5&CQL_FILTER=${encodeURIComponent(cql)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      if (!r.ok || t.includes("ExceptionReport") || t.includes("HTTP Status") || !t.includes("featureMember")) return null;
      if (t.includes('numberOfFeatures="0"') || t.includes("numberOfFeatures='0'")) return null;
      return t;
    } catch(e) { return null; }
  };

  // ── Find boring ─────────────────────────────────────────────────────────────
  // From GML sample field is <ms:dgunr> — try XML PropertyIsEqualTo first (exact match)
  // Also try dgunr_org which has format "146. 3602" (with space)
  let boringGML = null;
  const attempts = [];

  // Try 1: XML filter exact match on dgunr
  boringGML = await fetchWithXMLFilter("jupiter_boringer_ws", "dgunr", dgu);
  attempts.push({ method: "XML filter dgunr", found: !!boringGML });

  // Try 2: CQL exact match
  if (!boringGML) {
    boringGML = await fetchWithCQL("jupiter_boringer_ws", `dgunr = '${dgu}'`);
    attempts.push({ method: "CQL dgunr =", found: !!boringGML });
  }

  // Try 3: txt_search starts with DGU number (format: "182.218 Vandforsyning...")
  if (!boringGML) {
    boringGML = await fetchWithCQL("jupiter_boringer_ws", `txt_search LIKE '${dgu} %'`);
    attempts.push({ method: "CQL txt_search LIKE", found: !!boringGML });
  }

  // Try 4: dgunr_org field (has space: "182. 218")
  if (!boringGML) {
    const dguWithSpace = dgu.replace(".", ". ");
    boringGML = await fetchWithCQL("jupiter_boringer_ws", `dgunr_org LIKE '${dguWithSpace}%'`);
    attempts.push({ method: "CQL dgunr_org with space", found: !!boringGML });
  }

  if (!boringGML) {
    return res.status(404).json({ error: `Ingen boring fundet for DGU ${dgu}`, attempts });
  }

  // Verify the returned dgunr matches what we asked for (guard against partial matches)
  const returnedDgu = g(boringGML, "dgunr") || "";
  if (returnedDgu && returnedDgu !== dgu) {
    // Try next feature in collection or report mismatch
    return res.status(404).json({
      error: `WFS returnerede DGU ${returnedDgu} for søgning på ${dgu} — prøv et andet filter`,
      attempts,
      returnedDgu,
    });
  }

  const bf   = allFields(boringGML);
  const [utmx, utmy] = coords(boringGML);
  const borid = bf.borid || bf.id;

  // ── Fetch litologi via cyklogram URL ────────────────────────────────────────
  let litho = [];
  const cykloUrl = bf.cyklogram;

  if (cykloUrl) {
    try {
      const cr  = await fetch(cykloUrl, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const ct  = await cr.text();

      if (ct.includes("featureMember")) {
        // GML response
        const layerRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
        let lm;
        while ((lm = layerRe.exec(ct)) !== null) {
          const lf = allFields(lm[1]);
          litho.push({
            fraM:   lf.fra_m  || lf.fra  || lf.dybde_fra || lf.depth_from,
            tilM:   lf.til_m  || lf.til  || lf.dybde_til || lf.depth_to,
            tekst:  lf.litologi_tekst || lf.tekst || lf.beskrivelse || lf.symbol_tekst || lf.lithology,
            symbol: lf.symbol || lf.lith_symbol,
          });
        }
      } else if (ct.includes("<tr") || ct.includes("<td")) {
        // HTML table
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

  // Fallback: WFS layer jupiter_bor_cyklogram
  if (litho.length === 0 && borid) {
    const cykGML = await fetchWithXMLFilter("jupiter_bor_cyklogram", "borid", borid)
                || await fetchWithCQL("jupiter_bor_cyklogram", `borid=${borid}`);
    if (cykGML) {
      const layerRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
      let lm;
      while ((lm = layerRe.exec(cykGML)) !== null) {
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

  litho = litho
    .filter(l => l.fraM != null || l.tekst)
    .sort((a, b) => (parseFloat(a.fraM) || 0) - (parseFloat(b.fraM) || 0));

  // ── Check for PDF ────────────────────────────────────────────────────────────
  const dguNoDot = dgu.replace(/\./g, "");
  let pdfUrl = null;
  const pdfCandidates = [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu}.pdf`,
  ].filter(Boolean);

  for (const u of pdfCandidates) {
    try {
      const r  = await fetch(u, { method: "HEAD", headers: hdrs, signal: AbortSignal.timeout(4000) });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.toLowerCase().includes("pdf")) { pdfUrl = u; break; }
    } catch(_) {}
  }

  return res.status(200).json({
    boring: {
      dguNr:       bf.dgunr          || dgu,
      boringsid:   borid,
      formaal:     bf.formaal_tekst  || bf.formaal,
      anvendelse:  bf.anvendelse_tekst || bf.anvendelse,
      status:      bf.kode_tekst     || bf.kode,
      boremetode:  bf.broendborer,
      dato:        bf.dato           || bf.aar,
      kommune:     bf.kommunenavn,
      region:      bf.region_tekst,
      adresse:     bf.sted1,
      postnr:      bf.postnr,
      utmx:        utmx              || bf.xutm,
      utmy:        utmy              || bf.yutm,
      kote:        bf.terraen_kote,
      dybde:       bf.dybde_num      || bf.dybde,
      dataejer:    bf.dataejer,
      pdfUrl,
      boreholeUrl: bf.url,
      cykloUrl,
    },
    litho,
    anlaeg: [],
    vandstand: [],
    dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, attempts },
  });
};
