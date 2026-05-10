module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  // ?desc=1&layer=XXX  — DescribeFeatureType (shows all field names)
  if (req.query.desc) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=${layer}`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // ?sample=1&layer=XXX  — fetch 1 raw feature (no filter) to see field names + values
  if (req.query.sample) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${layer}&maxFeatures=1&outputFormat=application/json`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "application/json");
    return res.status(r.status).send(t);
  }

  // ?caps=1  — GetCapabilities
  if (req.query.caps) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX — eller brug ?sample=1 for at se feltnavne" });

  const dguNoDot  = dgu.replace(/\./g, "");
  const dguSlash  = dgu.replace(".", "/");

  // Try every conceivable filter combination
  const candidates = [
    // Standard field name variants
    `dgu_nr='${dgu}'`,
    `dgu_nr='${dguNoDot}'`,
    `dgunr='${dgu}'`,
    `dgunr='${dguNoDot}'`,
    `DGU_NR='${dgu}'`,
    `DGU_NR='${dguNoDot}'`,
    `dgu='${dgu}'`,
    `dgu='${dguNoDot}'`,
    // LIKE operator
    `dgu_nr LIKE '${dgu}'`,
    `dgu_nr LIKE '%${dgu}%'`,
    `dgu_nr LIKE '%${dguNoDot}%'`,
    // strConcat format variants (area.number)
    `dgu_nr='182218'`,
    `dgu_nr='182%2E218'`,
  ];

  const attempts = [];
  let found = null;

  for (const filter of candidates) {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(filter)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      const preview = text.slice(0, 200).replace(/\s+/g, " ");
      attempts.push({ filter, status: r.status, preview });

      if (r.ok && text.includes('"features"') && !text.includes("ExceptionReport")) {
        const j = JSON.parse(text);
        if (j.features && j.features.length > 0) {
          found = j.features[0];
          break;
        }
      }
    } catch(e) {
      attempts.push({ filter, error: e.message });
    }
  }

  if (!found) {
    // Return all attempts so we can see what GEUS actually returned
    return res.status(404).json({
      error: `Ingen boring fundet for DGU ${dgu}`,
      tip: "Kald /api/jupiter?sample=1 for at se et råeksempel med korrekte feltnavne",
      tip2: "Kald /api/jupiter?desc=1 for DescribeFeatureType",
      attempts,
    });
  }

  const p    = found.properties;
  const geom = found.geometry;

  // Return both normalised AND raw so we can see field names
  return res.status(200).json({
    boring: {
      dguNr:      p.dgu_nr || p.dgunr || p.DGU_NR || dgu,
      boringsid:  p.boringsid || p.BORINGSID,
      navn:       p.boring_navn || p.navn || p.BORING_NAVN,
      formaal:    p.formaal || p.FORMAAL,
      status:     p.status || p.STATUS,
      boremetode: p.boremetode || p.BOREMETODE,
      slutdato:   p.slutdato || p.SLUTDATO,
      kommune:    p.kommunenavn || p.KOMMUNENAVN || p.kommune,
      vejnavn:    p.vejnavn || p.VEJNAVN,
      husnr:      p.husnr || p.HUSNR,
      postnr:     p.postnr || p.POSTNR,
      utmx:       geom?.coordinates?.[0],
      utmy:       geom?.coordinates?.[1],
      kote:       p.kote || p.KOTE || p.terraenkote,
      dybde:      p.dybde || p.DYBDE || p.boringsdybde || p.totaldybde,
      forerorDybde:     p.foreror_dybde || p.foreror_laengde,
      forerorMateriale: p.foreror_mat || p.foreror_materiale,
      forerorDiameter:  p.foreror_indre_diam || p.foreror_diameter,
      filterFra:  p.filter_fra || p.filterfra,
      filterTil:  p.filter_til || p.filtertil,
      grundvandsmagasin: p.grundvandsmagasin || p.magasin,
      vandstand:  p.vandstand || p.ro_vandstand,
      pdfUrl:     p.doklink || p.pdf_url || p.rapport_url || null,
      _rawFields: Object.keys(p).sort(),   // ← shows exact field names from WFS
      _rawValues: p,                        // ← shows all raw values
    },
    anlaeg: [], litho: [], vandstand: [], dgu,
    _foundWithFilter: filter,
  });
};
