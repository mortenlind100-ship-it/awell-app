module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const hdrs = { Accept: "text/html,application/json,*/*", "User-Agent": "Mozilla/5.0 (compatible; Awell/1.0)" };

  if (req.query.ping) {
    try {
      const r = await fetch("https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=612324", { headers: hdrs, signal: AbortSignal.timeout(10000) });
      return res.status(200).json({ ok: r.ok, status: r.status, size: (await r.text()).length });
    } catch(e) { return res.status(200).json({ error: e.message }); }
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // ── Step 1: Find borid by fetching borerapport.jsp with dgunr param ──────────
  // Try several URL patterns - one of them will redirect or return the correct page
  const boridSearchUrls = [
    `https://data.geus.dk/JupiterWWW/borerapport.jsp?dgunr=${encodeURIComponent(dgu)}`,
    `https://data.geus.dk/JupiterWWW/borerapport.jsp?dguNr=${encodeURIComponent(dgu)}`,
    `https://data.geus.dk/JupiterWWW/borerapport.jsp?dgNr=${encodeURIComponent(dgu)}`,
    // Jupiter search page
    `https://data.geus.dk/JupiterWWW/index.jsp?dgunr=${encodeURIComponent(dgu)}`,
  ];

  let borid = null;
  let boreholeUrl = null;
  const step1attempts = [];

  for (const url of boridSearchUrls) {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000), redirect: "follow" });
      const text = await r.text();
      const finalUrl = r.url;
      step1attempts.push({ url: url.slice(35), status: r.status, finalUrl: finalUrl.slice(35), size: text.length, preview: text.slice(0,150).replace(/\s+/g," ") });

      // Check if redirected to borid URL
      const boridFromUrl = finalUrl.match(/borid=(\d+)/)?.[1];
      if (boridFromUrl) { borid = boridFromUrl; boreholeUrl = finalUrl; break; }

      // Scrape borid from HTML content
      const boridFromHtml = text.match(/borid[=:](\d{5,7})/i)?.[1]
        || text.match(/get_cyklogram\.jsp\?borid=(\d+)/)?.[1]
        || text.match(/borerapport\.jsp\?borid=(\d+)/)?.[1];
      if (boridFromHtml) { borid = boridFromHtml; break; }
    } catch(e) {
      step1attempts.push({ url: url.slice(35), error: e.message });
    }
  }

  // ── Step 2: If borid found, fetch WFS by FEATUREID ────────────────────────────
  // fid format: "jupiter_boringer_ws.{borid}"
  let boringXML = null;
  if (borid) {
    try {
      const wfsUrl = `https://data.geus.dk/geusmap/ows/25832.jsp?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&FEATUREID=jupiter_boringer_ws.${borid}`;
      const r = await fetch(wfsUrl, { headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      if (r.ok && t.includes("featureMember")) boringXML = t;
    } catch(_) {}
  }

  // ── Step 3: Fallback — WFS fast filter (dgunr='X') + verify ─────────────────
  if (!boringXML) {
    try {
      const wfsUrl = `https://data.geus.dk/geusmap/ows/25832.jsp?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=jupiter_boringer_ws&maxFeatures=5&CQL_FILTER=${encodeURIComponent(`dgunr='${dgu}'`)}`;
      const r = await fetch(wfsUrl, { headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      if (r.ok && t.includes("featureMember")) boringXML = t;
    } catch(_) {}
  }

  if (!borid && !boringXML) {
    return res.status(404).json({ error: `Kunne ikke finde boring for DGU ${dgu}`, step1attempts });
  }

  // ── Parse GML ────────────────────────────────────────────────────────────────
  const g = (xml, tag) => { const m = xml?.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i")); return m ? m[1].trim()||null : null; };
  const allFields = (xml) => { const out={}, re=/<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g; let m; while((m=re.exec(xml))!==null) out[m[1]]=m[2].trim(); return out; };
  const coords = (xml) => { const m=xml?.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/); if(!m) return [null,null]; const p=m[1].split(","); return [parseFloat(p[0]),parseFloat(p[1])]; };

  const bf   = boringXML ? allFields(boringXML) : {};
  const [utmx, utmy] = boringXML ? coords(boringXML) : [null, null];
  const resolvedBorid = borid || bf.borid || bf.id;
  const cykloUrl = bf.cyklogram || (resolvedBorid ? `https://data.geus.dk/geusmapmore/get_cyklogram.jsp?borid=${resolvedBorid}` : null);
  boreholeUrl = boreholeUrl || bf.url || (resolvedBorid ? `https://data.geus.dk/JupiterWWW/borerapport.jsp?borid=${resolvedBorid}` : null);

  // ── Litologi ─────────────────────────────────────────────────────────────────
  let litho = [];
  if (cykloUrl) {
    try {
      const cr = await fetch(cykloUrl, { headers: { Accept:"*/*","User-Agent":"Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
      const ct = await cr.text();
      const featureRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g; let lm;
      if (ct.includes("featureMember")) {
        while ((lm=featureRe.exec(ct))!==null) {
          const lf=allFields(lm[1]);
          litho.push({ fraM:lf.fra_m||lf.fra, tilM:lf.til_m||lf.til, tekst:lf.litologi_tekst||lf.tekst||lf.beskrivelse||lf.symbol_tekst, symbol:lf.symbol });
        }
      }
    } catch(_) {}
  }
  litho = litho.filter(l=>l.fraM||l.tekst).sort((a,b)=>(parseFloat(a.fraM)||0)-(parseFloat(b.fraM)||0));

  // ── PDF ──────────────────────────────────────────────────────────────────────
  let pdfUrl = null;
  for (const u of [
    resolvedBorid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${resolvedBorid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu.replace(/\./g,"")}.pdf`,
  ].filter(Boolean)) {
    try { const r=await fetch(u,{method:"HEAD",headers:hdrs,signal:AbortSignal.timeout(4000)}); if(r.ok&&(r.headers.get("content-type")||"").toLowerCase().includes("pdf")){pdfUrl=u;break;} } catch(_){}
  }

  return res.status(200).json({
    boring: {
      dguNr: bf.dgunr||dgu, boringsid: resolvedBorid,
      formaal: bf.formaal_tekst||bf.formaal, anvendelse: bf.anvendelse_tekst||bf.anvendelse,
      status: bf.kode_tekst||bf.kode, boremetode: bf.broendborer,
      dato: bf.dato||bf.aar, kommune: bf.kommunenavn, region: bf.region_tekst,
      adresse: bf.sted1, postnr: bf.postnr,
      utmx: utmx||parseFloat(bf.xutm), utmy: utmy||parseFloat(bf.yutm),
      kote: bf.terraen_kote, dybde: bf.dybde_num||bf.dybde, dataejer: bf.dataejer,
      pdfUrl, boreholeUrl, cykloUrl,
    },
    litho, anlaeg:[], vandstand:[], dgu,
    _meta: { borid: resolvedBorid, pdfUrl, lithoCount: litho.length, step1attempts },
  });
};
