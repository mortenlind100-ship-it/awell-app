// Vercel API — Supabase database proxy
// Handles all CRUD for boringer and opgaver
// Environment variables needed in Vercel:
//   SUPABASE_URL  = https://xxxx.supabase.co
//   SUPABASE_KEY  = your anon/public key

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ error: "Supabase miljøvariabler mangler. Tilføj SUPABASE_URL og SUPABASE_KEY i Vercel." });
  }

  const hdrs = {
    "Content-Type": "application/json",
    "apikey": SUPA_KEY,
    "Authorization": `Bearer ${SUPA_KEY}`,
    "Prefer": "return=representation",
  };

  const supa = async (path, method = "GET", body = null) => {
    const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
      method,
      headers: hdrs,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch(_) { return { ok: r.ok, status: r.status, data: text }; }
  };

  const { action, table } = req.query;

  try {
    // ── GET all ──────────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const t = table === "opgaver" ? "opgaver" : "boringer";
      const order = t === "boringer" ? "updated_at.desc" : "date.desc";
      const r = await supa(`${t}?order=${order}&limit=500`);
      return res.status(r.status).json(r.data);
    }

    // ── GET single ───────────────────────────────────────────
    if (req.method === "GET" && action === "get") {
      const { id } = req.query;
      const t = table === "opgaver" ? "opgaver" : "boringer";
      const r = await supa(`${t}?id=eq.${id}`);
      return res.status(r.status).json(Array.isArray(r.data) ? r.data[0] : r.data);
    }

    // ── UPSERT boring ─────────────────────────────────────────
    if (req.method === "POST" && table === "boringer") {
      const w = req.body;
      const row = {
        id:                  w.id,
        name:                w.name,
        lat:                 w.lat   ? parseFloat(w.lat)  : null,
        lng:                 w.lng   ? parseFloat(w.lng)  : null,
        depth:               w.depth || null,
        rovand:              w.rovand || null,
        maalepunkt:          w.maalepunkt || null,
        maalepunkt_hoejde:   w.maalepunktHoejde || null,
        casing:              w.casing || {},
        has_pump:            !!w.hasPump,
        pump:                w.pump || {},
        has_well_chamber:    !!w.hasWellChamber,
        well_chamber:        w.wellChamber || {},
        well_images:         w.wellImages || [],
      };
      const r = await supa("boringer?on_conflict=id", "POST", row);
      return res.status(r.ok ? 200 : r.status).json(r.data);
    }

    // ── DELETE boring ─────────────────────────────────────────
    if (req.method === "DELETE" && table === "boringer") {
      const { id } = req.query;
      const r = await supa(`boringer?id=eq.${id}`, "DELETE");
      return res.status(r.ok ? 200 : r.status).json({ deleted: id });
    }

    // ── UPSERT opgave ─────────────────────────────────────────
    if (req.method === "POST" && table === "opgaver") {
      const t = req.body;
      const row = {
        id:         t.id,
        well_id:    t.wellId,
        type:       t.type,
        date:       t.date,
        gps:        t.gps || {},
        notes:      t.notes || null,
        tech_name:  t.techName || null,
        tech_phone: t.techPhone || null,
        images:     t.images || [],
        task_data:  {
          syring:    t.syring,
          tilstand:  t.tilstand,
          renovering: t.renovering,
          opfoering: t.opfoering,
          foring:    t.foring,
          sloejfning: t.sloejfning,
        },
      };
      const r = await supa("opgaver?on_conflict=id", "POST", row);
      return res.status(r.ok ? 200 : r.status).json(r.data);
    }

    // ── DELETE opgave ─────────────────────────────────────────
    if (req.method === "DELETE" && table === "opgaver") {
      const { id } = req.query;
      const r = await supa(`opgaver?id=eq.${id}`, "DELETE");
      return res.status(r.ok ? 200 : r.status).json({ deleted: id });
    }

    return res.status(400).json({ error: `Ukendt handling: ${req.method} ${action} ${table}` });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
