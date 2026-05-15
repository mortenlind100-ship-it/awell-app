module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const WFS  = "https://data.geus.dk/geusmap/ows/25832.jsp";
  const hdrs = { Accept: "*/*", "User-Agent": "Mozilla/5.0 Awell/1.0" };

  if (req.query.ping) {
    try {
      const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetCapabilities`, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      return res.status(200).json({ ok: r.ok, status: r.status });
    } catch(e) { return res.status(200).json({ error: e.message }); }
  }
  if (req.query.sample) {
    const r = await fetch(`${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=${req.query.layer||"jupiter_boringer_ws"}&maxFeatures=1`, { headers: hdrs });
    res.setHeader("Content-Type","text/xml");
    return res.status(r.status).send(await r.text());
  }

  const dgu = (req.query.dgu || "").trim();
  if (!dgu) return res.status(400).json({ error: "Mangler ?dgu=XXX.XXX" });

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const g = (xml, tag) => { const m = xml.match(new RegExp(`<ms:${tag}[^>]*>([^<]*)<\\/ms:${tag}>`, "i")); return m ? m[1].trim()||null : null; };
  const allFields = (xml) => { const out={}, re=/<ms:([a-zA-Z0-9_]+)[^>]*>([^<]*)<\/ms:/g; let m; while((m=re.exec(xml))!==null) out[m[1]]=m[2].trim(); return out; };
  const coords = (xml) => { const m=xml.match(/<gml:coordinates[^>]*>([\d.,-]+)<\/gml:coordinates>/); if(!m) return [null,null]; const p=m[1].split(","); return [parseFloat(p[0]),parseFloat(p[1])]; };
  const fetchRaw = async (url, ms=20000) => { try { const r=await fetch(url,{headers:hdrs,signal:AbortSignal.timeout(ms)}); return {ok:r.ok,status:r.status,text:await r.text()}; } catch(e) { return {ok:false,error:e.message}; } };
  const firstFeature = (xml) => { const m=xml.match(/<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/); return m?m[1]:null; };
  const allFeatures = (xml) => { const re=/<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g; const out=[]; let m; while((m=re.exec(xml))!==null) out.push(m[1]); return out; };
  const isGoodGML = (t) => t && !t.includes("ExceptionReport") && !t.includes("HTTP Status") && t.includes("featureMember") && !t.includes('numberOfFeatures="0"');

  // ── Build OGC XML filters ────────────────────────────────────────────────────
  // txt_search starts with "182.218 Vandforsyningsboring..."
  // OGC PropertyIsLike: dot is a singleChar wildcard → must escape with !
  const dguEscaped = dgu.replace(/\./g, "!.");  // "182!.218"

  // dgunr_org format: "146. 3602" — area + ". " + number
  const parts = dgu.split(".");
  const dguOrgPattern = parts.length === 2 ? `${parts[0]}!. ${parts[1]}*` : null;

  const ogcLikeTxtSearch = `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc">
    <ogc:PropertyIsLike wildCard="*" singleChar="?" escape="!" matchCase="false">
      <ogc:PropertyName>txt_search</ogc:PropertyName>
      <ogc:Literal>${dguEscaped} *</ogc:Literal>
    </ogc:PropertyIsLike>
  </ogc:Filter>`;

  const ogcLikeDgunrOrg = dguOrgPattern ? `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc">
    <ogc:PropertyIsLike wildCard="*" singleChar="?" escape="!" matchCase="false">
      <ogc:PropertyName>dgunr_org</ogc:PropertyName>
      <ogc:Literal>${dguOrgPattern}</ogc:Literal>
    </ogc:PropertyIsLike>
  </ogc:Filter>` : null;

  // Also try FeatureId lookup via the borid if we can derive it
  // dgunr_org "182. 218" → try as FEATUREID hint

  const strategies = [
    { label: "OGC LIKE txt_search", filter: ogcLikeTxtSearch },
    ...(ogcLikeDgunrOrg ? [{ label: "OGC LIKE dgunr_org", filter: ogcLikeDgunrOrg }] : []),
  ];

  const attempts = [];
  let boringXML = null;

  for (const s of strategies) {
    const url = `${WFS}?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature`
      + `&typeName=jupiter_boringer_ws&maxFeatures=10`
      + `&FILTER=${encodeURIComponent(s.filter)}`;
    const raw = await fetchRaw(url, 20000);
    const preview = (raw.text||"").slice(0,200).replace(/\s+/g," ");
    attempts.push({ label: s.label, status: raw.status, error: raw.error, preview });

    if (!raw.ok || !isGoodGML(raw.text)) continue;

    // Verify dgunr matches
    const features = allFeatures(raw.text);
    for (const fxml of features) {
      const fDgu = g(fxml,"dgunr")||"";
      const fOrg = (g(fxml,"dgunr_org")||"").replace(/\.\s+/,".").trim();
      if (fDgu === dgu || fOrg === dgu) { boringXML = fxml; break; }
    }
    // If no exact match but results came back, take first (LIKE should be precise enough)
    if (!boringXML && features.length > 0) {
      boringXML = features[0];
      attempts[attempts.length-1].note = `Tog første af ${features.length} resultater`;
    }
    if (boringXML) break;
  }

  if (!boringXML) {
    return res.status(404).json({
      error: `Ingen boring fundet for DGU ${dgu}`,
      attempts,
    });
  }

  const bf   = allFields(boringXML);
  const [utmx, utmy] = coords(boringXML);
  const borid    = bf.borid || bf.id;
  const cykloUrl = bf.cyklogram;

  // ── Litologi ─────────────────────────────────────────────────────────────────
  let litho = [];
  if (cykloUrl) {
    try {
      const cr = await fetch(cykloUrl, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      const ct = await cr.text();
      if (ct.includes("featureMember")) {
        const features = allFeatures(ct);
        for (const f of features) {
          const lf = allFields(f);
          litho.push({ fraM: lf.fra_m||lf.fra, tilM: lf.til_m||lf.til, tekst: lf.litologi_tekst||lf.tekst||lf.beskrivelse||lf.symbol_tekst, symbol: lf.symbol });
        }
      } else if (ct.includes("<td")) {
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
        while ((rm=rowRe.exec(ct))!==null) {
          const cells = rm[1].match(/<td[^>]*>([^<]*)<\/td>/gi);
          if (cells&&cells.length>=2) { const v=cells.map(c=>c.replace(/<[^>]+>/g,"").trim()); if(v[0]&&!isNaN(parseFloat(v[0]))) litho.push({fraM:v[0],tilM:v[1],tekst:v[2]||null}); }
        }
      }
    } catch(_) {}
  }
  litho = litho.filter(l=>l.fraM||l.tekst).sort((a,b)=>(parseFloat(a.fraM)||0)-(parseFloat(b.fraM)||0));

  // ── PDF ──────────────────────────────────────────────────────────────────────
  let pdfUrl = null;
  for (const u of [
    borid ? `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${borid}.pdf` : null,
    `https://data.geus.dk/JupiterWWW/Redigering/Dokumenter/${dgu.replace(/\./g,"")}.pdf`,
  ].filter(Boolean)) {
    try { const r=await fetch(u,{method:"HEAD",headers:hdrs,signal:AbortSignal.timeout(4000)}); if(r.ok&&(r.headers.get("content-type")||"").toLowerCase().includes("pdf")){pdfUrl=u;break;} } catch(_){}
  }

  return res.status(200).json({
    boring: {
      dguNr: bf.dgunr||dgu, boringsid: borid,
      formaal: bf.formaal_tekst||bf.formaal, anvendelse: bf.anvendelse_tekst||bf.anvendelse,
      status: bf.kode_tekst||bf.kode, boremetode: bf.broendborer, dato: bf.dato||bf.aar,
      kommune: bf.kommunenavn, region: bf.region_tekst, adresse: bf.sted1, postnr: bf.postnr,
      utmx: utmx||parseFloat(bf.xutm), utmy: utmy||parseFloat(bf.yutm),
      kote: bf.terraen_kote, dybde: bf.dybde_num||bf.dybde, dataejer: bf.dataejer,
      pdfUrl, boreholeUrl: bf.url, cykloUrl,
    },
    litho, anlaeg:[], vandstand:[], dgu,
    _meta: { borid, pdfUrl, lithoCount: litho.length, attempts },
  });
};
