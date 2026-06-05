module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const hdrs = { Accept: "text/html,application/json,*/*", "User-Agent": "Mozilla/5.0 (compatible; Awell/1.0)" };
  const wfsHdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0" };

  // ?raw=borid  — return raw borerapport HTML for inspection
  if (req.query.raw) {
    try {
      const r = await fetch(`https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${req.query.raw}`, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      res.setHeader("Content-Type","text/html");
      return res.status(r.status).send(t);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ?cyklo=borid  — return raw cyklogram for inspection  
  if (req.query.cyklo) {
    try {
      const r = await fetch(`https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=${req.query.cyklo}`, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      res.setHeader("Content-Type", r.headers.get("content-type") || "text/plain");
      return res.status(r.status).send(t);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ?links=borid — extract all hrefs and PDF references from borerapport HTML
  if (req.query.links) {
    try {
      const r = await fetch(`https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${req.query.links}`, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      // Extract all href and src attributes
      const hrefs = [...t.matchAll(/href=["']([^"']+)["']/gi)].map(m=>m[1]);
      const srcs  = [...t.matchAll(/src=["']([^"']+)["']/gi)].map(m=>m[1]);
      const pdfs  = [...t.matchAll(/([^"' ]+\.pdf[^"' ]*)/gi)].map(m=>m[1]);
      const iframes = [...t.matchAll(/iframe[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);
      // Also look for "dokument", "rapport", "tegning", "profil" keywords
      const docLinks = hrefs.filter(h => /dokument|rapport|tegning|profil|pdf|bor/i.test(h));
      return res.status(200).json({ hrefs: hrefs.slice(0,50), srcs: srcs.slice(0,20), pdfs, iframes, docLinks, bodyLength: t.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ?pdf=borid — proxy PDF directly (HEAD check + redirect)
  if (req.query.pdf) {
    const borid = req.query.pdf;
    const candidates = [
      `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf`,
      `https://data.geus.dk/boredokument/${borid}.pdf`,
      `https://data.geus.dk/JupiterWWW/dokument/${borid}.pdf`,
      `https://data.geus.dk/JupiterWWW/borprofil/${borid}.pdf`,
    ];
    for (const u of candidates) {
      try {
        const r = await fetch(u, { method:"HEAD", headers: hdrs, signal: AbortSignal.timeout(6000) });
        if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf")) {
          res.setHeader("Location", u);
          return res.status(302).end();
        }
      } catch(_) {}
    }
    return res.status(404).json({ error: "Ingen PDF fundet", tried: candidates });
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const g = (xml, tag) => { const m = xml?.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i")); return m ? m[1].trim()||null : null; };
  const allFields = (xml) => { const out={}, re=/<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g; let m; while((m=re.exec(xml??""))) out[m[1]]=m[2].trim(); return out; };
  const gCoords = (xml) => { const m=xml?.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/); if(!m) return [null,null]; const p=m[1].split(","); return [parseFloat(p[0]),parseFloat(p[1])]; };
  const allFeatures = (xml) => { const re=/<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g, out=[]; let m; while((m=re.exec(xml??""))) out.push(m[1]); return out; };

  // HTML scraping helper: extract table section by heading
  const scrapeTable = (html, heading) => {
    const rows = [];
    // Find the section containing the heading
    const hIdx = html.toLowerCase().indexOf(heading.toLowerCase());
    if (hIdx === -1) return rows;
    const section = html.slice(hIdx, hIdx + 8000);
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(section)) !== null) {
      const cells = rm[1].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
      if (cells) {
        const vals = cells.map(c => c.replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").trim()).filter(Boolean);
        if (vals.length >= 2) rows.push(vals);
      }
    }
    return rows;
  };

  // ── Step 1: Find borid via borerapport.jsp?dgunr= ────────────────────────────
  let borid = null;
  let boreholeHtml = null;

  try {
    const url = `https://data.geus.dk/JupiterWWW/borerapport.jsp?dgunr=${encodeURIComponent(dgu)}`;
    const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(15000), redirect: "follow" });
    const text = await r.text();

    // Extract borid from page content
    borid = r.url.match(/borid=(\d+)/)?.[1]
         || text.match(/borid=(\d+)/i)?.[1]
         || text.match(/get_cyklogram\.jsp\?borid=(\d+)/)?.[1]
         || text.match(/borerapport\.jsp\?borid=(\d+)/)?.[1];

    if (borid && r.status === 200 && text.length > 1000) {
      boreholeHtml = text; // Save for scraping
    }
  } catch(e) {
    return res.status(502).json({ error: "Kunne ikke kontakte GEUS: " + e.message });
  }

  if (!borid) {
    return res.status(404).json({ error: `Ingen boring fundet for DGU ${dgu}` });
  }

  // ── Step 2: Fetch WFS data by FEATUREID (fast - primary key lookup) ───────────
  let bf = {};
  let utmx = null, utmy = null;
  try {
    const wfsUrl = `https://data.geus.dk/geusmap/ows/25832.jsp?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&FEATUREID=jupiter_boringer_ws.${borid}`;
    const r = await fetch(wfsUrl, { headers: wfsHdrs, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    if (r.ok && t.includes("featureMember")) {
      bf = allFields(t);
      [utmx, utmy] = gCoords(t);
    }
  } catch(_) {}

  // ── Step 3: Scrape borerapport HTML for rich data ─────────────────────────────
  // If we don't have the HTML yet, fetch it now
  if (!boreholeHtml) {
    try {
      const r = await fetch(`https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${borid}`, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      if (r.ok) boreholeHtml = await r.text();
    } catch(_) {}
  }

  // Extract key data from HTML
  let htmlData = {};
  let lithoFromHtml = [];
  let vandstandFromHtml = [];

  if (boreholeHtml) {
    const h = boreholeHtml;

    // Extract structured data using regex patterns common in Danish government HTML
    // ── Boringsopbygning: Forerør (Diameter + Bund) ──────────────────────────
    // Tabel under "Boringsopbygning" / "Forerør" – kolonner: Top, Bund, Diameter, ...
    const forerRows = scrapeTable(h, "Forerør");
    // Find rækker med numeriske værdier; kolonner er typisk: Top | Bund | Diameter
    const forerData = forerRows.filter(r => r.length >= 2 && r.some(c => /^[\d.,]+$/.test(c)));
    // Hent alle forerørssektioner (kan være flere)
    const forerSections = forerData.map(r => {
      // Find tal i rækkefølge: Top, Bund, Diameter
      const nums = r.map(c => c.replace(",",".")).filter(c => /^[\d.]+$/.test(c));
      return { top: parseFloat(nums[0])||0, bund: parseFloat(nums[1])||0, dia: parseFloat(nums[2])||0 };
    }).filter(s => s.dia > 0 && s.bund > 0);

    // ── Boringsopbygning: Filter (Fra, Til, Diameter) ─────────────────────────
    const filterRows = scrapeTable(h, "Filter");
    const filterData = filterRows.filter(r => r.length >= 2 && r.some(c => /^[\d.,]+$/.test(c)));
    const filterSections = filterData.map(r => {
      const nums = r.map(c => c.replace(",",".")).filter(c => /^[\d.]+$/.test(c));
      return { fra: parseFloat(nums[0])||0, til: parseFloat(nums[1])||0, dia: parseFloat(nums[2])||0 };
    }).filter(s => s.dia > 0);

    // ── Vandstand: Seneste pejling ────────────────────────────────────────────
    // vandstandFromHtml er allerede scraped: [{ dato, pejling, kote, maalerNavn }]
    // Sortér efter dato faldende og tag seneste
    const vandRows2 = scrapeTable(h, "Vandstand");
    // Rækker: dato | pejling | kote | ...  – seneste er typisk øverst
    const senestePejling = vandRows2
      .filter(r => r.length >= 2 && r[0].match(/\d/) && r[1].match(/[\d.,]/))
      .slice(0, 1)
      .map(r => ({ dato: r[0].trim(), pejling: r[1].replace(",",".").trim() }))[0] || null;

    htmlData = {
      dguNr:      h.match(/DGU[- ]?nr[.:]?\s*<[^>]+>\s*([\d.]+)/i)?.[1] || dgu,
      boringNavn: h.match(/Boringens navn[^<]*<[^>]+>\s*([^<]+)/i)?.[1]?.trim(),
      ejer:       h.match(/Ejer[^<]*<[^>]+>\s*([^<]+)/i)?.[1]?.trim(),
      journal:    h.match(/Journal[^<]*<[^>]+>\s*([^<]+)/i)?.[1]?.trim(),
      boreDato:   h.match(/Bored[^<]*<[^>]+>\s*([\d.\-/]+)/i)?.[1]?.trim(),
      dybde:      h.match(/[Tt]otal.*?dybde[^<]*<[^>]+>\s*([\d.,]+)/i)?.[1]?.trim(),
      indvinding: h.match(/[Ii]ndvinding[^<]*<[^>]+>\s*([\d.,]+)/i)?.[1]?.trim(),
      // Forerør – primær sektion (størst diameter / øverst)
      forerDiam:  forerSections.length > 0 ? String(forerSections[0].dia) : null,
      forerBund:  forerSections.length > 0 ? String(forerSections[0].bund) : null,
      forerSections,   // alle sektioner til multi-diameter beregning
      // Filter – primær sektion
      filterDia:  filterSections.length > 0 ? String(filterSections[0].dia) : null,
      filterFra:  filterSections.length > 0 ? String(filterSections[0].fra) : null,
      filterTil:  filterSections.length > 0 ? String(filterSections[0].til) : null,
      filterSections,  // alle filtersektioner
      // Vandstand: seneste pejling
      senestePejling,
      rovandstand: senestePejling ? senestePejling.pejling : null,
    };

    // Scrape litologi table
    const lithoRows = scrapeTable(h, "litologi");
    lithoFromHtml = lithoRows
      .filter(r => r.length >= 2 && !isNaN(parseFloat(r[0])))
      .map(r => ({ fraM: r[0], tilM: r[1], tekst: r[2] || r[3] || null, symbol: r[4] || null }));

    // Scrape vandstand/pejling table
    const vandRows = scrapeTable(h, "vandstand");
    vandstandFromHtml = vandRows
      .filter(r => r.length >= 2 && (r[0].match(/\d/) || r[1].match(/\d/)))
      .slice(0, 20)
      .map(r => ({ dato: r[0], pejling: r[1], kote: r[2] || null, maalerNavn: r[3] || null }));
  }

  // ── Step 4: Litologi from cyklogram (GML) ────────────────────────────────────
  let litho = lithoFromHtml;
  if (litho.length === 0) {
    try {
      const cUrl = `https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=${borid}`;
      const cr = await fetch(cUrl, { headers: wfsHdrs, signal: AbortSignal.timeout(10000) });
      const ct = await cr.text();
      const features = allFeatures(ct);
      for (const f of features) {
        const lf = allFields(f);
        litho.push({ fraM: lf.fra_m||lf.fra, tilM: lf.til_m||lf.til, tekst: lf.litologi_tekst||lf.tekst||lf.beskrivelse||lf.symbol_tekst, symbol: lf.symbol });
      }
    } catch(_) {}
  }
  litho = litho.filter(l=>l.fraM||l.tekst).sort((a,b)=>(parseFloat(a.fraM)||0)-(parseFloat(b.fraM)||0));

  // ── PDF: extract from HTML first, then try known patterns ──────────────────
  let pdfUrl = null;

  // 1. Look for PDF links in scraped HTML
  if (boreholeHtml) {
    const pdfMatches = [...boreholeHtml.matchAll(/href=["']([^"']*\.pdf[^"']*)/gi)].map(m=>m[1]);
    const iframeMatches = [...boreholeHtml.matchAll(/iframe[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);
    for (const link of [...pdfMatches, ...iframeMatches]) {
      const absUrl = link.startsWith("http") ? link : `https://data.geus.dk${link.startsWith("/") ? "" : "/JupiterWWW/"}${link}`;
      try {
        const r = await fetch(absUrl, { method:"HEAD", headers: wfsHdrs, signal: AbortSignal.timeout(5000) });
        if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf")) { pdfUrl = absUrl; break; }
      } catch(_) {}
    }
  }

  // 2. Try known URL patterns
  if (!pdfUrl) {
    for (const u of [
      `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf`,
      `https://data.geus.dk/JupiterWWW/borprofil/${borid}.pdf`,
      `https://data.geus.dk/boredokument/${borid}.pdf`,
      `https://data.geus.dk/JupiterWWW/dokument/${borid}.pdf`,
      `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu.replace(/\./g,"")}.pdf`,
    ]) {
      try {
        const r = await fetch(u, { method:"HEAD", headers: wfsHdrs, signal: AbortSignal.timeout(4000) });
        if (r.ok && (r.headers.get("content-type")||"").toLowerCase().includes("pdf")) { pdfUrl = u; break; }
      } catch(_) {}
    }
  }

  // Always expose the borerapport HTML page as fallback (contains boreprofil)
  const boreholePageUrl = `https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${borid}`;

  const cykloUrl = `https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=${borid}`;

  return res.status(200).json({
    boring: {
      dguNr:       bf.dgunr       || htmlData.dguNr    || dgu,
      boringsid:   borid,
      navn:        htmlData.boringNavn,
      formaal:     bf.formaal_tekst  || bf.formaal,
      anvendelse:  bf.anvendelse_tekst || bf.anvendelse,
      status:      bf.kode_tekst   || bf.kode,
      boremetode:  bf.broendborer,
      dato:        bf.dato         || htmlData.boreDato,
      ejer:        htmlData.ejer,
      journal:     htmlData.journal,
      kommune:     bf.kommunenavn,
      region:      bf.region_tekst,
      adresse:     bf.sted1,
      postnr:      bf.postnr,
      utmx:        utmx            || parseFloat(bf.xutm),
      utmy:        utmy            || parseFloat(bf.yutm),
      kote:        bf.terraen_kote,
      dybde:       bf.dybde_num   || bf.dybde || htmlData.dybde,
      forerorDiameter: htmlData.forerDiam,
      forerorBund:     htmlData.forerBund,
      forerorSections: htmlData.forerSections || [],
      filterDiameter:  htmlData.filterDia,
      filterFra:       htmlData.filterFra,
      filterTil:       htmlData.filterTil,
      filterSections:  htmlData.filterSections || [],
      rovandstand:     htmlData.rovandstand,
      senestePejling:  htmlData.senestePejling,
      indvinding:  htmlData.indvinding,
      dataejer:    bf.dataejer,
      pdfUrl,
      boreholeUrl: boreholePageUrl,
      cykloUrl,
    },
    litho,
    vandstand: vandstandFromHtml,
    anlaeg: [],
    dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, vandstandCount: vandstandFromHtml.length, htmlDataKeys: Object.keys(htmlData).filter(k=>htmlData[k]) },
  });
};
