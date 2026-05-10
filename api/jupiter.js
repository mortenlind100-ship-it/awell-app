module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  // ?caps=1 — GetCapabilities (find permitted output formats)
  if (req.query.caps) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // ?desc=1 — DescribeFeatureType
  if (req.query.desc) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=${layer}`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // ?sample=1 — fetch 1 raw GML feature to see field names
  if (req.query.sample) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${layer}&maxFeatures=1`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  const dguNoDot = dgu.replace(/\./g, "");

  // GML output formats to try (no JSON allowed per server config)
  const formats = ["GML2", "text/xml; subtype=gml/3.1.1", "text/xml"];
  
  // Filter variants to try
  const filters = [
    `dgu_nr='${dgu}'`,
    `dgu_nr='${dguNoDot}'`,
    `dgunr='${dgu}'`,
    `dgunr='${dguNoDot}'`,
    `DGU_NR='${dgu}'`,
    `DGU_NR='${dguNoDot}'`,
    `dgu='${dgu}'`,
    `dgu_nr LIKE '%${dgu}%'`,
    `dgu_nr LIKE '%${dguNoDot}%'`,
  ];

  const attempts = [];
  let gmlText = null;
  let usedFilter = null;

  for (const filter of filters) {
    // Try without specifying outputFormat first (server default = GML2)
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
      + `&typeName=jupiter_boringer_ws&maxFeatures=1`
      + `&CQL_FILTER=${encodeURIComponent(filter)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      const preview = text.slice(0, 200).replace(/\s+/g, " ");
      attempts.push({ filter, status: r.status, preview });

      if (r.ok && !text.includes("ExceptionReport") && !text.includes("HTTP Status")
          && (text.includes("featureMember") || text.includes("FeatureCollection"))) {
        // Check it actually has a feature (not empty collection)
        if (!text.includes('numberOfFeatures="0"') && !text.includes("numberOfFeatures='0'")) {
          gmlText = text;
          usedFilter = filter;
          break;
        } else {
          attempts[attempts.length-1].note = "Tom samling";
        }
      }
    } catch(e) {
      attempts.push({ filter, error: e.message });
    }
  }

  if (!gmlText) {
    return res.status(404).json({
      error: `Ingen boring fundet for DGU ${dgu}`,
      tip: "Kald /api/jupiter?sample=1 for at se GML-struktur med korrekte feltnavne",
      tip2: "Kald /api/jupiter?desc=1 for DescribeFeatureType",
      attempts,
    });
  }

  // ── Parse GML with regex ────────────────────────────────────────────────────
  // Extract any tag value: <ns:tagname>value</ns:tagname>
  const gml = (tag) => {
    const re = new RegExp(`<[^>]*:?${tag}[\\s>][^>]*>([^<]*)<`, "i");
    const m  = gmlText.match(re);
    return m ? m[1].trim() : null;
  };

  // Extract all tag:value pairs for raw output
  const rawFields = {};
  const tagRe = /<([a-zA-Z_][a-zA-Z0-9_:.-]*)>([^<]{1,200})</g;
  let m;
  while ((m = tagRe.exec(gmlText)) !== null) {
    const key = m[1].replace(/^[^:]+:/, ""); // strip namespace prefix
    if (!["FeatureCollection","featureMember","boundedBy","Box","coordinates"].includes(key)) {
      rawFields[key] = m[2].trim();
    }
  }

  // Try to find PDF document link in GML
  const pdfUrl = gml("doklink") || gml("pdf_url") || gml("rapport_url")
               || gml("dokument_url") || gml("boredokument") || null;

  // Also try known GEUS PDF URL pattern based on DGU
  const pdfCandidates = [
    pdfUrl,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu}.pdf`,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
    `https://data.geus.dk/boredokument/${dguNoDot}.pdf`,
  ].filter(Boolean);

  let confirmedPdf = null;
  for (const u of pdfCandidates) {
    try {
      const r = await fetch(u, { method: "HEAD", headers: hdrs, signal: AbortSignal.timeout(4000) });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.includes("pdf")) { confirmedPdf = u; break; }
    } catch(_) {}
  }

  return res.status(200).json({
    boring: {
      dguNr:      gml("dgu_nr") || gml("dgunr") || gml("DGU_NR") || dgu,
      boringsid:  gml("boringsid") || gml("BORINGSID"),
      navn:       gml("boring_navn") || gml("BORING_NAVN") || gml("navn"),
      formaal:    gml("formaal") || gml("FORMAAL") || gml("anvendelse"),
      status:     gml("status") || gml("STATUS"),
      boremetode: gml("boremetode") || gml("BOREMETODE"),
      slutdato:   gml("slutdato") || gml("SLUTDATO"),
      indberetningsdato: gml("indberetningsdato") || gml("INDBERETNINGSDATO"),
      kommune:    gml("kommunenavn") || gml("KOMMUNENAVN") || gml("kommune"),
      vejnavn:    gml("vejnavn") || gml("VEJNAVN"),
      husnr:      gml("husnr") || gml("HUSNR"),
      postnr:     gml("postnr") || gml("POSTNR"),
      postdistrikt: gml("postdistrikt") || gml("POSTDISTRIKT"),
      kote:       gml("kote") || gml("KOTE") || gml("terraenkote"),
      dybde:      gml("dybde") || gml("DYBDE") || gml("boringsdybde") || gml("totaldybde"),
      forerorDybde:     gml("foreror_dybde") || gml("foreror_laengde") || gml("casing_dybde"),
      forerorMateriale: gml("foreror_mat") || gml("foreror_materiale") || gml("casing_mat"),
      forerorDiameter:  gml("foreror_indre_diam") || gml("foreror_diameter") || gml("indre_diam"),
      filterFra:  gml("filter_fra") || gml("filterfra") || gml("screen_fra"),
      filterTil:  gml("filter_til") || gml("filtertil") || gml("screen_til"),
      grundvandsmagasin: gml("grundvandsmagasin") || gml("magasin") || gml("magasintype"),
      vandstand:  gml("vandstand") || gml("ro_vandstand") || gml("pejling"),
      pdfUrl:     confirmedPdf,
      _rawFields: rawFields,   // all field names + values for debugging
    },
    anlaeg: [], litho: [], vandstand: [], dgu,
    _meta: { usedFilter, pdfUrl: confirmedPdf },
  });
};
