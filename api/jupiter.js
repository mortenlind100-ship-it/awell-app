const _jupiterHandler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const hdrs = { Accept: "text/html,application/json,*/*", "User-Agent": "Mozilla/5.0 (compatible; Awell/1.0)" };
  const wfsHdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0" };

  // ?raw=borid  — return raw borerapport HTML for inspection
  if (req.query.raw) {
    try {
      const r = await fetch(`https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${req.query.raw}`, { headers: hdrs, signal: AbortSignal.timeout(3000) });
      const t = await r.text();
      res.setHeader("Content-Type","text/html");
      return res.status(r.status).send(t);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ?cyklo=borid  — return raw cyklogram for inspection  
  if (req.query.cyklo) {
    try {
      const r = await fetch(`https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=${req.query.cyklo}`, { headers: hdrs, signal: AbortSignal.timeout(3000) });
      const t = await r.text();
      res.setHeader("Content-Type", r.headers.get("content-type") || "text/plain");
      return res.status(r.status).send(t);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ?links=borid — extract all hrefs and PDF references from borerapport HTML
  if (req.query.links) {
    try {
      const r = await fetch(`https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${req.query.links}`, { headers: hdrs, signal: AbortSignal.timeout(3000) });
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
        const r = await fetch(u, { method:"HEAD", headers: hdrs, signal: AbortSignal.timeout(2000) });
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
        const vals = cells.map(c => c.replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").trim());
        if (vals.filter(Boolean).length >= 2) rows.push(vals);
      }
    }
    return rows;
  };

  // ── Step 1: Find borid via borerapport.jsp?dgunr= ────────────────────────────
  let borid = null;
  let boreholeHtml = null;

  try {
    const url = `https://data.geus.dk/JupiterWWW/borerapport.jsp?dgunr=${encodeURIComponent(dgu)}`;
    const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000), redirect: "follow" });
    const text = await r.text();

    // Extract borid from page content
    borid = r.url.match(/borid=(\d+)/)?.[1]
         || text.match(/borid=(\d+)/i)?.[1]
         || text.match(/get_cyklogram\.jsp\?borid=(\d+)/)?.[1]
         || text.match(/borerapport\.jsp\?borid=(\d+)/)?.[1];

    // Gem kun HTML hvis det er selve borerapporten (ikke en søgeliste)
    // En rigtig borerapport indeholder "Boringsopbygning" eller "Forerør"
    if (borid && r.status === 200 && text.length > 1000
        && (text.includes("Boringsopbygning") || text.includes("Forerør") || text.includes("Vandstand"))) {
      boreholeHtml = text;
    }
    // Ellers: borid er fundet men siden er en søgeliste - boreholeHtml hentes i Step 3
  } catch(e) {
    // Step 1 fejlede - forsøger alligevel med WFS i step 2+3
  }

  if (!borid) {
    return res.status(404).json({ error: "Ingen boring fundet for DGU " + dgu + ". Tjek nummeret eller prøv igen." });
  }

  // ── Step 2+3: WFS og borerapport HTML køres PARALLELT ──────────────────────
  // Vercel hobby-plan: 10s limit. Parallel udførelse er afgørende.
  let bf = {};
  let utmx = null, utmy = null;

  await Promise.allSettled([
    // Step 2: WFS FEATUREID (hurtigt primærnøgle-opslag)
    (async () => {
      try {
        const wfsUrl = "https://data.geus.dk/geusmap/ows/25832.jsp?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&FEATUREID=jupiter_boringer_ws." + borid;
        const r = await fetch(wfsUrl, { headers: wfsHdrs, signal: AbortSignal.timeout(8000) });
        const t = await r.text();
        if (r.ok && t.includes("featureMember")) {
          bf = allFields(t);
          [utmx, utmy] = gCoords(t);
        }
      } catch(_) {}
    })(),
    // Step 3: Borerapport HTML via borid (rig scraping-kilde)
    (async () => {
      if (boreholeHtml) return; // Step 1 gav os allerede en god rapport
      try {
        const reportUrl = "https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=" + borid;
        const r = await fetch(reportUrl, { headers: hdrs, signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const t = await r.text();
          if (t.includes("Forerør") || t.includes("Vandstand") || t.includes("Boringsopbygning")) {
            boreholeHtml = t;
          }
        }
      } catch(_) {}
    })(),
  ]);

  // Extract key data from HTML
  let htmlData = {};
  let lithoFromHtml = [];
  let vandstandFromHtml = [];

  if (boreholeHtml) {
    const h = boreholeHtml;

    // Extract structured data using regex patterns common in Danish government HTML
    // ── Header-bevidst kolonne-lookup ────────────────────────────────────────
    // Returnerer et objekt { headers: [...], rows: [{kolonne: værdi}] }
    // baseret på første række som header-række.
    const parseTableByHeaders = (rows) => {
      if (rows.length < 2) return { headers: [], rows: [] };
      const headers = rows[0].map(h2 => h2.toLowerCase().replace(/[()]/g,"").trim());
      const dataRows = rows.slice(1).filter(r => r.some(c => /\d/.test(c)));
      return {
        headers,
        rows: dataRows.map(r => {
          const obj = {};
          headers.forEach((hdr, i) => { obj[hdr] = ((r[i] ?? "").replace(",",".").trim()); });
          return obj;
        })
      };
    };

    const colVal = (row, ...names) => {
      for (const n of names) {
        const key = Object.keys(row).find(k => k.includes(n.toLowerCase()));
        if (key && row[key] && /\d/.test(row[key])) return parseFloat(row[key]) || 0;
      }
      return 0;
    };

    // ── Boringsopbygning scope ────────────────────────────────────────────────
    // Afgrænser søgningen til Boringsopbygning-sektionen for præcision
    const boringsopbygningIdx = h.indexOf("Boringsopbygning");
    const hScope = boringsopbygningIdx >= 0 ? h.slice(boringsopbygningIdx, boringsopbygningIdx + 20000) : h;

    // ── Forerør: alle sektioner med Top, Bund, Diameter ──────────────────────
    // Jupiter-tabelkolonner (fra screenshot): Stamme | Top* | Bund* | Materiale | Diameter
    // Overskriften hedder "Forerør" (uden e til sidst)
    const forerRows = scrapeTable(hScope, "Forerør");
    const forerParsed = parseTableByHeaders(forerRows);
    const forerSections = forerParsed.rows.map(r => ({
      top:  colVal(r, "top"),
      bund: colVal(r, "bund"),
      // Prøv "indv" først (indvendig dia.), derefter "diameter"
      dia:  colVal(r, "indv") || colVal(r, "diameter"),
      materiale: Object.entries(r).find(([k]) => k.includes("mater"))?.[1] || "",
    })).filter(s => s.dia > 0 && s.bund > 0);

    // ── Filtre: kun AKTIVE sektioner baseret på Periode-kolonnen ────────────
    // Jupiter-kolonner: Stamme | Indtagsnr | Top* | Bund* | Top** | Bund** | Materiale | Diameter | Slidsbredde | Periode
    // Periode-formater:
    //   "3. juli 2009 -"   → aktiv (starter dato, slutter med bindestreg)
    //   "- 3. juli 2009"   → udgået (starter med bindestreg, slutter dato)
    //   "3. juli 2009 - 1. jan 2020" → afgrænset periode, udgået
    // Vi beholder KUN rækker hvor periode slutter med " -" (dvs. stadig aktiv)
    const filterRows = scrapeTable(hScope, "Filtre");

    // parseTableByHeaders bruger første række som headers.
    // Problemet: "top" og "bund" forekommer to gange i headeren.
    // Løsning: lav vores eget row-parse der tager kolonner ved INDEX.
    const filterAllRows = filterRows.filter(r => r.length >= 4);

    // Parse filter-sektioner: kun aktive perioder (periode slutter med " -")
    let filterSections = [];
    let filterSectionsUniq = [];

    if (filterAllRows.length >= 2) {
      const fHeaders    = filterAllRows[0].map(h2 => h2.toLowerCase().replace(/[()* ]/g, ""));
      const diaIdx      = fHeaders.findIndex(h2 => h2.includes("diameter"));
      const periodeIdx  = fHeaders.findIndex(h2 => h2.includes("periode"));
      const materIdx    = fHeaders.findIndex(h2 => h2.includes("mater"));
      const topIdx  = 2;   // Top* (m u.t.) er altid kolonne 2 (efter Stamme, Indtagsnr)
      const bundIdx = 3;   // Bund* (m u.t.) er altid kolonne 3

      const alleRaekker = filterAllRows.slice(1).map(r => {
        const periode = periodeIdx >= 0 ? ((r[periodeIdx] ?? "").trim()) : "";
        return {
          fra:       parseFloat((r[topIdx]  || "").replace(",", ".")) || 0,
          til:       parseFloat((r[bundIdx] || "").replace(",", ".")) || 0,
          dia:       parseFloat((diaIdx >= 0 ? (r[diaIdx] ?? "") : "").replace(",", ".")) || 0,
          materiale: materIdx >= 0 ? ((r[materIdx] ?? "").trim()) : "",
          periode,
          // Aktiv = perioden slutter med " -" (åben slutdato = stadig aktiv)
          aktiv: /[-–]\s*$/.test(periode),
        };
      }).filter(s => s.dia > 0 && s.til > 0);

      // Forsøg 1: kun aktive perioder
      const aktive = alleRaekker.filter(s => s.aktiv);
      const kandidater = aktive.length > 0 ? aktive : alleRaekker;

      // Deduplikér på fra+til+dia
      filterSectionsUniq = kandidater.filter((s, i, arr) =>
        arr.findIndex(x => x.fra === s.fra && x.til === s.til && x.dia === s.dia) === i
      );
      filterSections = filterSectionsUniq;
    }

    // ── Vandstand: Seneste rovandspejling ─────────────────────────────────────
    // Jupiter borerapporten har en sektion "Seneste pejling" med én tabel-række:
    //   Dato | Pejling (m u.t.) | Kote (m DNN) | Målernavn
    // Vi søger specifikt i "Seneste pejling"-sektionen for at undgå at blande
    // den med den fulde vandstandstabel som kan indeholde hundredvis af målinger.
    let senestePejling = null;
    const senesteIdx = h.indexOf("Seneste pejling");
    const vandScope  = senesteIdx >= 0 ? h.slice(senesteIdx, senesteIdx + 3000) : h;
    const vandRows2  = scrapeTable(vandScope, "Dato");  // Tabellen starter med "Dato"-kolonne
    if (vandRows2.length === 0) {
      // Fallback: søg i den fulde vandstand-sektion
      const vandRows3 = scrapeTable(h, "Vandstand");
      const vandParsed3 = parseTableByHeaders(vandRows3);
      if (vandParsed3.rows.length > 0) {
        const r = vandParsed3.rows[0];
        const datoKey = Object.keys(r).find(k => k.includes("dato"));
        const pejlKey = Object.keys(r).find(k =>
          k.includes("pejling") || k.includes("m u") || k.includes("mut")
        );
        if (datoKey || pejlKey) {
          senestePejling = {
            dato:    ((r[datoKey] ?? "")).trim(),
            pejling: ((r[pejlKey] ?? "").replace(",", ".").trim()),
          };
        }
      }
    } else {
      // scrapeTable("Dato") starter fra "Dato"-teksten i <th> og returnerer
      // kun DATA-rækker (ikke header). vandRows2[0] er altså første datarække.
      // Kolonnerækkefølge: [Dato, Pejling (m u.t.), Kote (m DNN), Målernavn]
      if (vandRows2.length >= 1) {
        const r = vandRows2[0]; // første datarække
        // Jupiter kolonner: Indtagsnr(0) | Vandstand*(1) | Vandstandskote(2) | Dato(3)
        // Detektér kolonnerækkefølge: hvis r[0] er et heltal (Indtagsnr), brug r[1]+r[3]
        // Ellers fald tilbage til r[0]+r[1] (gammel format: Dato | Pejling)
        const forsteErIndtag = /^\d+$/.test((r[0] || "").trim());
        senestePejling = {
          pejling: (forsteErIndtag ? r[1] : r[1] || r[0] || "").replace(",", ".").trim(),
          dato:    (forsteErIndtag ? r[3] : r[0] || "").trim(),
        };
      }
    }

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
      filterSections,        // alle filtersektioner (inkl. dubletter)
      filterSectionsUniq,    // deduplikerede filtersektioner
      // Vandstand: seneste pejling
      senestePejling,
      rovandstand: senestePejling ? senestePejling.pejling : null,
    };

    // Scrape litologi table
    // Jupiter bruger overskriften "Geologi" (ikke "Litologi") for geologi-tabellen
    const lithoRows = scrapeTable(h, "Geologi");
    // Jupiter Geologi-tabel kolonner:
    // Top*(0) | Bund*(1) | Top**(2) | Bund**(3) | DGU-symbol(4) | Beskrivelse(5)
    lithoFromHtml = lithoRows
      .filter(r => r.length >= 2 && !isNaN(parseFloat((r[0]||"").replace(",","."))))
      .map(r => ({
        fraM:       (r[0] || "").replace(",", "."),
        tilM:       (r[1] || "").replace(",", "."),
        symbol:     r[4] || r[2] || null,
        beskrivelse: r[5] || r[3] || r[2] || null,
        tekst:      r[5] || r[4] || r[2] || null,
      }));

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
      const cr = await fetch(cUrl, { headers: wfsHdrs, signal: AbortSignal.timeout(5000) });
      const ct = await cr.text();
      const features = allFeatures(ct);
      for (const f of features) {
        const lf = allFields(f);
        litho.push({ fraM: lf.fra_m||lf.fra, tilM: lf.til_m||lf.til, tekst: lf.litologi_tekst||lf.tekst||lf.beskrivelse||lf.symbol_tekst, symbol: lf.symbol, beskrivelse: lf.beskrivelse||lf.litologi_tekst||lf.tekst||null });
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
        const r = await fetch(absUrl, { method:"HEAD", headers: wfsHdrs, signal: AbortSignal.timeout(2000) });
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
        const r = await fetch(u, { method:"HEAD", headers: wfsHdrs, signal: AbortSignal.timeout(2000) });
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
      filterSections:  htmlData.filterSectionsUniq || htmlData.filterSections || [],
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    await _jupiterHandler(req, res);
  } catch(e) {
    try { res.status(500).json({ error: "Serverfejl: " + e.message }); } catch(_) {}
  }
};
