module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  const WFS = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Awell/1.0" };

  // If ?caps=1 — return raw GetCapabilities for debugging
  if (req.query.caps) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // If ?desc=1 — return DescribeFeatureType for the layer
  if (req.query.desc) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=jupiter_boringer_ws`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // Build WFS GetFeature queries with different field name variants
  // DGU format: "182.218" — also try without dot: "182218"
  const dguNoDot = dgu.replace(".", "");
  
  const queries = [
    // WFS 1.0.0 with various field names and filters
    `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&outputFormat=application/json&maxFeatures=1&CQL_FILTER=dgu_nr='${dgu}'`,
    `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&outputFormat=application/json&maxFeatures=1&CQL_FILTER=dgunr='${dgu}'`,
    `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&outputFormat=application/json&maxFeatures=1&CQL_FILTER=dgu_nr='${dguNoDot}'`,
    `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&outputFormat=application/json&maxFeatures=1&CQL_FILTER=dgu_nr+LIKE+'${dgu}'`,
    // WFS 2.0.0
    `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&typeNames=jupiter_boringer_ws&outputFormat=application/json&count=1&CQL_FILTER=dgu_nr='${dgu}'`,
    `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&typeNames=jupiter_boringer_ws&outputFormat=application/json&count=1&CQL_FILTER=dgunr='${dgu}'`,
    // GML output (fallback)
    `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=1&CQL_FILTER=dgu_nr='${dgu}'`,
  ];

  const attempts = [];
  let found = null;

  for (const url of queries) {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      const preview = text.slice(0, 150).replace(/\s+/g, " ");
      attempts.push({ url: url.split("CQL_FILTER")[0].slice(-40) + "CQL_FILTER=" + (url.split("CQL_FILTER=")[1]||""), status: r.status, preview });

      if (r.ok && !text.includes("ExceptionReport") && !text.includes("<!doctype")) {
        // Try JSON parse (GeoJSON)
        if (text.includes('"features"') || text.includes('"type":"Feature"')) {
          const j = JSON.parse(text);
          if (j.features && j.features.length > 0) {
            found = { format: "geojson", feature: j.features[0] };
            break;
          }
          if (j.features && j.features.length === 0) {
            attempts[attempts.length-1].note = "Tomt resultat – DGU ikke fundet";
            continue;
          }
        }
        // GML response — still useful, parse key fields
        if (text.includes("gml:") || text.includes("featureMember")) {
          found = { format: "gml", raw: text };
          break;
        }
      }
    } catch(e) {
      attempts.push({ url: url.slice(-60), error: e.message });
    }
  }

  if (!found) {
    return res.status(502).json({
      error: `Ingen data fundet for DGU ${dgu} i GEUS WFS`,
      attempts,
    });
  }

  // Parse GeoJSON features
  if (found.format === "geojson") {
    const p = found.feature.properties;
    const geom = found.feature.geometry;
    return res.status(200).json({
      boring: {
        dguNr:      p.dgu_nr    || p.dgunr    || p.DGU_NR    || dgu,
        boringsid:  p.boringsid || p.BORINGSID,
        navn:       p.boring_navn || p.navn   || p.BORING_NAVN,
        formaal:    p.formaal   || p.FORMAAL,
        status:     p.status    || p.STATUS,
        kommune:    p.kommunenavn || p.KOMMUNENAVN || p.kommune,
        adresse:    [p.vejnavn, p.husnr, p.postnr].filter(Boolean).join(" "),
        utmx:       geom?.coordinates?.[0],
        utmy:       geom?.coordinates?.[1],
        kote:       p.kote      || p.KOTE     || p.terraenkote,
        dybde:      p.dybde     || p.DYBDE    || p.boringsdybde || p.totaldybde,
        boremetode: p.boremetode || p.BOREMETODE,
        slutdato:   p.slutdato  || p.SLUTDATO,
        _kilde:     "GEUS WFS GeoJSON (jupiter_boringer_ws)",
        _felter:    Object.keys(p), // vis alle tilgængelige felter
      },
      litho: [], vandstand: [], dgu,
    });
  }

  // GML fallback — extract key values with regex
  if (found.format === "gml") {
    const gml = found.raw;
    const extract = (tag) => {
      const m = gml.match(new RegExp(`<[^>]*:?${tag}[^>]*>([^<]+)<`, "i"));
      return m ? m[1].trim() : null;
    };
    return res.status(200).json({
      boring: {
        dguNr:     extract("dgu_nr") || dgu,
        navn:      extract("boring_navn") || extract("navn"),
        formaal:   extract("formaal"),
        status:    extract("status"),
        kommune:   extract("kommunenavn") || extract("kommune"),
        kote:      extract("kote") || extract("terraenkote"),
        dybde:     extract("dybde") || extract("boringsdybde"),
        boremetode:extract("boremetode"),
        slutdato:  extract("slutdato"),
        _kilde:    "GEUS WFS GML (jupiter_boringer_ws)",
      },
      litho: [], vandstand: [], dgu,
    });
  }
};
