// Vercel diagnostik endpoint — tester Supabase forbindelse
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;

  const results = {
    timestamp: new Date().toISOString(),
    vercel: { ok: true, region: process.env.VERCEL_REGION || "ukendt" },
    env: {
      SUPABASE_URL: SUPA_URL ? `✅ sat (${SUPA_URL.slice(0,30)}...)` : "❌ MANGLER",
      SUPABASE_KEY: SUPA_KEY ? `✅ sat (${SUPA_KEY.slice(0,8)}...)` : "❌ MANGLER",
    },
    supabase: null,
    boringer: null,
    opgaver: null,
  };

  if (!SUPA_URL || !SUPA_KEY) {
    results.supabase = "❌ Kan ikke teste — miljøvariabler mangler";
    return res.status(200).json(results);
  }

  const hdrs = { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}`, "Content-Type": "application/json" };

  // Test 1: kan vi nå Supabase?
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/`, { headers: hdrs, signal: AbortSignal.timeout(8000) });
    results.supabase = r.ok ? `✅ Forbundet (HTTP ${r.status})` : `⚠️ HTTP ${r.status}`;
  } catch(e) {
    results.supabase = `❌ Forbindelsesfejl: ${e.message}`;
    return res.status(200).json(results);
  }

  // Test 2: boringer-tabel
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/boringer?limit=1`, { headers: hdrs, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (r.ok) {
      results.boringer = `✅ Tabel tilgængelig · ${Array.isArray(d) ? d.length : "?"} rækker hentet`;
    } else {
      results.boringer = `❌ Fejl: ${JSON.stringify(d).slice(0,120)}`;
    }
  } catch(e) {
    results.boringer = `❌ ${e.message}`;
  }

  // Test 3: opgaver-tabel
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/opgaver?limit=1`, { headers: hdrs, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (r.ok) {
      results.opgaver = `✅ Tabel tilgængelig · ${Array.isArray(d) ? d.length : "?"} rækker hentet`;
    } else {
      results.opgaver = `❌ Fejl: ${JSON.stringify(d).slice(0,120)}`;
    }
  } catch(e) {
    results.opgaver = `❌ ${e.message}`;
  }

  // Test 4: skriv en test-række og slet den igen
  try {
    const testId = "test-" + Date.now();
    const wRes = await fetch(`${SUPA_URL}/rest/v1/boringer`, {
      method: "POST",
      headers: { ...hdrs, "Prefer": "return=representation" },
      body: JSON.stringify({ id: testId, name: "DIAGNOSTIK TEST — slettes automatisk" }),
      signal: AbortSignal.timeout(8000),
    });
    if (wRes.ok) {
      // Slet igen
      await fetch(`${SUPA_URL}/rest/v1/boringer?id=eq.${testId}`, { method: "DELETE", headers: hdrs });
      results.skrivtest = "✅ Skrive- og slettetest bestået";
    } else {
      const err = await wRes.text();
      results.skrivtest = `❌ Skriv fejlede: ${err.slice(0,120)}`;
    }
  } catch(e) {
    results.skrivtest = `❌ ${e.message}`;
  }

  // Samlet vurdering
  const allOk = Object.values(results).every(v => typeof v !== "string" || v.startsWith("✅") || v === results.timestamp);
  results.samlet = allOk ? "✅ ALT VIRKER — data gemmes og deles mellem teknikere" : "⚠️ Se fejl ovenfor";

  return res.status(200).json(results);
};
