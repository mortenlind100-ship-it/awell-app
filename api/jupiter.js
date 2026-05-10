// Vercel proxy — GEUS Jupiter WFS + dokumenter
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const dgu   = (req.query.dgu  || "").trim();
  const debug = req.query.debug === "1";
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Awell/1.0" };
  const sig  = AbortSignal.timeout(12000);

  // ── Helper ──────────────────────────────────────────────────────────────────
  const getWFS = async (typeName, cqlFilter) => {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
      + `&typeName=${typeName}&outputFormat=application/json`
      + `&maxFeatures=200&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;
    try {
      const r = await fetch(url, { headers: hdrs, signal: sig });
      const t = await r.text();
      if (!r.ok || t.includes("ExceptionReport") || t.includes("<!doctype")) return null;
      const j = JSON.parse(t);
      return j.features || [];
    } catch(e) { return null; }
  };

  // ── DescribeFeatureType helper (for debug) ──────────────────────────────────
  if (req.query.desc) {
    const layer = req.query.layer || "jupiter_boringer_ws";
    const r = await fetch(
      `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=DescribeFeatureType&typeName=${layer}`,
      { headers: hdrs }
    );
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // ── GetCapabilities (for debug) ─────────────────────────────────────────────
  if (req.query.caps) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs });
    const t = await r.text();
    res.setHeader("Content-Type", "text/xml");
    return res.status(r.status).send(t);
  }

  // ── Try multiple DGU field name variants ────────────────────────────────────
  const dguNoDot = dgu.replace(/\./g, "");
  const filters = [
    `dgu_nr='${dgu}'`, `dgunr='${dgu}'`, `dgu_nr='${dguNoDot}'`,
    `DGU_NR='${dgu}'`, `dgu_nr LIKE '${dgu}'`,
  ];

  let boringFeatures = null;
  let usedFilter = null;
  for (const f of filters) {
    const r = await getWFS("jupiter_boringer_ws", f);
    if (r && r.length > 0) { boringFeatures = r; usedFilter = f; break; }
  }
  if (!boringFeatures) {
    return res.status(404).json({ error: `Ingen boring fundet for DGU ${dgu}` });
  }

  const bf   = boringFeatures[0];
  const bp   = bf.properties;
  const geom = bf.geometry;

  // Get the internal boring ID for sub-queries
  const boringsid = bp.boringsid || bp.BORINGSID || bp.boring_id || bp.id;

  // ── Fetch anlaeg (facilities/intakes) ───────────────────────────────────────
  let anlaegFeatures = [];
  if (boringsid) {
    const af = await getWFS("jupiter_anlaeg_ws", `boringsid=${boringsid}`);
    if (af) anlaegFeatures = af;
  }
  // fallback: search by DGU
  if (!anlaegFeatures.length) {
    for (const f of filters.slice(0, 2)) {
      const af = await getWFS("jupiter_anlaeg_ws", f);
      if (af && af.length) { anlaegFeatures = af; break; }
    }
  }

  // ── Fetch cyklogram (lithology log) ─────────────────────────────────────────
  let cykloFeatures = [];
  if (boringsid) {
    const cf = await getWFS("jupiter_bor_cyklogram", `boringsid=${boringsid}`);
    if (cf) cykloFeatures = cf;
  }
  if (!cykloFeatures.length) {
    for (const f of filters.slice(0, 2)) {
      const cf = await getWFS("jupiter_bor_cyklogram", f);
      if (cf && cf.length) { cykloFeatures = cf; break; }
    }
  }

  // ── Check for PDF document ───────────────────────────────────────────────────
  // Jupiter stores borehole reports as PDFs - try known URL patterns
  const dguSlash = dgu.replace(".", "/");
  const pdfCandidates = [
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu}.pdf`,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dguNoDot}.pdf`,
    `https://data.geus.dk/boredokument/${dguNoDot}.pdf`,
    `https://data.geus.dk/boredokument/${dgu}.pdf`,
    bp.dokument_url || bp.pdf_url || bp.rapport_url || null,
    bp.doklink || bp.dok_link || null,
  ].filter(Boolean);

  let pdfUrl = null;
  for (const u of pdfCandidates) {
    try {
      const r = await fetch(u, { method: "HEAD", headers: hdrs, signal: AbortSignal.timeout(5000) });
      if (r.ok && (r.headers.get("content-type") || "").includes("pdf")) {
        pdfUrl = u; break;
      }
    } catch(_) {}
  }

  // ── Normalise boring properties ─────────────────────────────────────────────
  const v = (p, ...keys) => { for (const k of keys) { const val = p[k] || p[k.toUpperCase()] || p[k.toLowerCase()]; if (val != null && val !== "") return val; } return null; };

  const boring = {
    dguNr:             v(bp, "dgu_nr","dgunr","DGU_NR")              || dgu,
    boringsid:         v(bp, "boringsid","boring_id","BORINGSID"),
    navn:              v(bp, "boring_navn","navn","borings_navn","BORING_NAVN"),
    formaal:           v(bp, "formaal","FORMAAL","anlaeg_type","anvendelse"),
    status:            v(bp, "status","STATUS","borings_status"),
    boremetode:        v(bp, "boremetode","BOREMETODE","boemetode"),
    slutdato:          v(bp, "slutdato","SLUTDATO","afsluttet"),
    indberetningsdato: v(bp, "indberetningsdato","INDBERETNINGSDATO"),
    kommune:           v(bp, "kommunenavn","KOMMUNENAVN","kommune_navn","kommune"),
    vejnavn:           v(bp, "vejnavn","VEJNAVN"),
    husnr:             v(bp, "husnr","HUSNR"),
    postnr:            v(bp, "postnr","POSTNR"),
    postdistrikt:      v(bp, "postdistrikt","POSTDISTRIKT"),
    utmx:              geom?.coordinates?.[0],
    utmy:              geom?.coordinates?.[1],
    kote:              v(bp, "kote","KOTE","terraenkote","TERRAENKOTE","kote_saet"),
    dybde:             v(bp, "dybde","DYBDE","boringsdybde","BORINGSDYBDE","totaldybde"),
    forerorDybde:      v(bp, "foreror_dybde","foreroer_dybde","casing_dybde"),
    forerorMateriale:  v(bp, "foreror_materiale","foreroer_materiale","casing_materiale"),
    forerorDiameter:   v(bp, "foreror_diameter","foreroer_diameter","indre_diameter"),
    filterFra:         v(bp, "filter_fra","filterfra","screen_fra"),
    filterTil:         v(bp, "filter_til","filtertil","screen_til"),
    grundvandsmagasin: v(bp, "grundvandsmagasin","magasin","MAGASIN"),
    vandstand:         v(bp, "vandstand","VANDSTAND","ro_vandstand"),
    pdfUrl,
    _allefelter:       debug ? Object.keys(bp).sort() : undefined,
    _allevaerdier:     debug ? bp : undefined,
  };

  // ── Normalise anlaeg ────────────────────────────────────────────────────────
  const anlaeg = anlaegFeatures.map(f => {
    const p = f.properties;
    return {
      anlaegId:   v(p, "anlaegid","anlaeg_id","id"),
      type:       v(p, "anlaeg_type","type","TYPE","anvendelse"),
      navn:       v(p, "anlaeg_navn","navn","NAME"),
      kapacitet:  v(p, "kapacitet","ydelse","KAPACITET"),
      dybde:      v(p, "dybde","DYBDE","intake_dybde"),
      status:     v(p, "status","STATUS"),
      _debug:     debug ? p : undefined,
    };
  });

  // ── Normalise cyklogram / lithology ────────────────────────────────────────
  const litho = cykloFeatures.map(f => {
    const p = f.properties;
    return {
      fraM:       v(p, "fra_m","FRA_M","fra","depth_from","dybde_fra"),
      tilM:       v(p, "til_m","TIL_M","til","depth_to","dybde_til"),
      tekst:      v(p, "litologi_tekst","tekst","TEKST","lith_tekst","beskrivelse","lithology"),
      symbol:     v(p, "symbol","SYMBOL","lith_symbol"),
      farve:      v(p, "farve","FARVE","color"),
      _debug:     debug ? p : undefined,
    };
  }).sort((a, b) => (parseFloat(a.fraM)||0) - (parseFloat(b.fraM)||0));

  return res.status(200).json({ boring, anlaeg, litho, vandstand: [], dgu,
    _meta: { usedFilter, boringCount: boringFeatures.length, anlaegCount: anlaeg.length, lithoCount: litho.length, pdfUrl }
  });
};
