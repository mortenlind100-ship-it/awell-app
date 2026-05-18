// Vercel API — Export data to Excel (XLSX) for OneDrive
// Uses ExcelJS via CDN-compatible approach with raw XLSX format

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ error: "Supabase miljøvariabler mangler" });
  }

  const hdrs = { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` };

  try {
    // Fetch all data
    const [borRes, opRes] = await Promise.all([
      fetch(`${SUPA_URL}/rest/v1/boringer?order=name&limit=500`, { headers: hdrs }),
      fetch(`${SUPA_URL}/rest/v1/opgaver?order=date.desc&limit=2000`, { headers: hdrs }),
    ]);
    const boringer = await borRes.json();
    const opgaver  = await opRes.json();

    // Return as JSON for client-side Excel generation
    if (req.query.format === "json") {
      return res.status(200).json({ boringer, opgaver, exportedAt: new Date().toISOString() });
    }

    // Build CSV exports (universally compatible)
    const dt = new Date().toLocaleDateString("da-DK");

    // Boringer CSV
    const borHeaders = ["ID","Navn","Lat","Lng","UTM_E","UTM_N","Dybde","Rovand","Målepunkt","Kommune (Jupiter)","Forerør indre Ø","Forerør ydre Ø","Forerør materiale","Har pumpe","Pumpetype","Stigrør dim","Stigrør længde","Har brønd","Brønd dybde","Brønd ring Ø","Opdateret"];
    const borRows = boringer.map(w => [
      w.id, w.name, w.lat, w.lng,
      w.lat && w.lng ? Math.round(wgs84ToUtm(w.lat,w.lng).e) : "",
      w.lat && w.lng ? Math.round(wgs84ToUtm(w.lat,w.lng).n) : "",
      w.depth || "", w.rovand || "", w.maalepunkt || "", "",
      w.casing?.innerDia || "", w.casing?.outerDia || "", w.casing?.material || "",
      w.has_pump ? "Ja" : "Nej",
      w.pump?.type || "", w.pump?.riserDim || "", w.pump?.riserLength || "",
      w.has_well_chamber ? "Ja" : "Nej",
      w.well_chamber?.depth || "", w.well_chamber?.ringDia || "",
      w.updated_at ? new Date(w.updated_at).toLocaleDateString("da-DK") : "",
    ]);

    // Opgaver CSV
    const opHeaders = ["ID","Boring ID","Boring navn","Opgavetype","Dato","Tekniker","Telefon","GPS Lat","GPS Lng","UTM_E","UTM_N","Noter","Antal billeder","Opdateret"];
    const borMap = Object.fromEntries(boringer.map(b => [b.id, b.name]));
    const TASK_LABELS = { syring:"Syring/Regenerering", tilstand:"Tilstandsvurdering", renovering:"Renovering", opfoering:"Opføring", foring:"Ny Foring", sloejfning:"Sløjfning" };
    const opRows = opgaver.map(t => [
      t.id, t.well_id, borMap[t.well_id] || t.well_id,
      TASK_LABELS[t.type] || t.type || "",
      t.date ? new Date(t.date).toLocaleDateString("da-DK") : "",
      t.tech_name || "", t.tech_phone || "",
      t.gps?.lat || "", t.gps?.lng || "",
      t.gps?.lat && t.gps?.lng ? Math.round(wgs84ToUtm(t.gps.lat,t.gps.lng).e) : "",
      t.gps?.lat && t.gps?.lng ? Math.round(wgs84ToUtm(t.gps.lat,t.gps.lng).n) : "",
      t.notes || "", (t.images || []).length,
      t.updated_at ? new Date(t.updated_at).toLocaleDateString("da-DK") : "",
    ]);

    const toCsv = (headers, rows) =>
      [headers, ...rows].map(r => r.map(v => `"${String(v||"").replace(/"/g,'""')}"`).join(";")).join("\r\n");

    // Return both CSVs as JSON payload for client to handle
    return res.status(200).json({
      boringerCsv: toCsv(borHeaders, borRows),
      opgaverCsv:  toCsv(opHeaders, opRows),
      boringerCount: boringer.length,
      opgaverCount:  opgaver.length,
      exportedAt: new Date().toISOString(),
      filename: `Awell_Feltdata_${dt.replace(/\./g,"-")}`,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

// UTM32 conversion (server-side)
function wgs84ToUtm(lat, lng) {
  const a=6378137,f=1/298.257223563,b=a*(1-f),e2=1-(b/a)**2,k0=0.9996,lon0=9*Math.PI/180;
  const latR=lat*Math.PI/180,lngR=lng*Math.PI/180;
  const N=a/Math.sqrt(1-e2*Math.sin(latR)**2),T=Math.tan(latR)**2,C=e2/(1-e2)*Math.cos(latR)**2,A=Math.cos(latR)*(lngR-lon0);
  const e4=e2**2,e6=e2**3;
  const M=a*((1-e2/4-3*e4/64-5*e6/256)*latR-(3*e2/8+3*e4/32+45*e6/1024)*Math.sin(2*latR)+(15*e4/256+45*e6/1024)*Math.sin(4*latR)-(35*e6/3072)*Math.sin(6*latR));
  return {
    e: k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120)+500000,
    n: k0*(M+N*Math.tan(latR)*(A**2/2+(5-T+9*C+4*C**2)*A**4/24+(61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720)),
  };
}
