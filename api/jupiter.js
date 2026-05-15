module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  // ?ping — test basic connectivity to GEUS
  if (req.query.ping) {
    try {
      const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`;
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      return res.status(200).json({
        httpStatus: r.status,
        contentType: r.headers.get("content-type"),
        bodyStart: text.slice(0, 300),
        ok: r.ok,
      });
    } catch(e) {
      return res.status(200).json({ error: e.message, errorType: e.constructor.name });
    }
  }

  if (req.query.sample) {
    try {
      const layer = req.query.layer || "jupiter_boringer_ws";
      const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${layer}&maxFeatures=1`;
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const t = await r.text();
      res.setHeader("Content-Type", "text/xml");
      return res.status(r.status).send(t);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX — eller brug ?ping=1 for at teste forbindelsen" });

  // Helper: extract ms: tag value
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

  // Fetch with full error details
  const fetchGML = async (label, url) => {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      const preview = t.slice(0, 200).replace(/\s+/g, " ");
      const isEmpty = t.includes('numberOfFeatures="0"') || t.includes("numberOfFeatures='0'") || !t.includes("featureMember");
      const isError = t.includes("ExceptionReport") || t.includes("HTTP Status");
      return {
        label, url: url.slice(50),
        httpStatus: r.status,
        isEmpty, isError, preview,
        text: (!isEmpty && !isError && r.ok) ? t : null,
      };
    } catch(e) {
      return { label, url: url.slice(50), error: e.message, errorType: e.constructor.name };
    }
  };

  const strategies = [
    { label: "txt_search LIKE dgu+space",
      url: `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`txt_search LIKE '${dgu} %'`)}` },
    { label: "txt_search LIKE dgu (no space)",
      url: `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`txt_search LIKE '${dgu}%'`)}` },
    { label: "dgunr_org LIKE dgu+dot+space",
      url: `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`dgunr_org LIKE '${dgu.replace(".", ". ")}%'`)}` },
    { label: "dgunr_org = dgu",
      url: `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`dgunr_org = '${dgu}'`)}` },
    { label: "dgunr = dgu (original)",
      url: `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`dgunr = '${dgu}'`)}` },
  ];

  const attempts = [];
  let boringGML = null;

  for (const s of strategies) {
    const result = await fetchGML(s.label, s.url);
    attempts.push({ label: result.label, httpStatus: result.httpStatus, isEmpty: result.isEmpty, isError: result.isError, error: result.error, errorType: result.errorType, preview: result.preview });
    if (result.text) {
      const returnedDgu = g(result.text, "dgunr") || "";
      attempts[attempts.length-1].returnedDgu = returnedDgu;
      if (returnedDgu === dgu) { boringGML = result.text; break; }
    }
  }

  if (!boringGML) {
    return res.status(404).json({ error: `Ingen præcis match for DGU ${dgu}`, attempts });
  }

  const bf   = allFields(boringGML);
  const [utmx, utmy] = coords(boringGML);
  const borid    = bf.borid || bf.id;
  const cykloUrl = bf.cyklogram;

  // Litologi
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
          litho.push({ fraM: lf.fra_m||lf.fra, tilM: lf.til_m||lf.til, tekst: lf.litologi_tekst||lf.tekst||lf.beskrivelse||lf.symbol_tekst, symbol: lf.symbol });
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

  // PDF
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
    litho, anlaeg: [], vandstand: [], dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, attempts },
  });
};
