// Worker único (modelo unificado actual de Cloudflare, no Pages clásico).
// Maneja tres cosas:
//   1. /c/:slug        -> redirect + contador de toques (público, sin login)
//   2. /api/*          -> API del panel (protegida con contraseña)
//   3. cualquier otra ruta -> se sirve como archivo estático desde /public

const FALLBACK_PATH = "/error.html";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/") {
        return Response.redirect(new URL("/panel.html", request.url).toString(), 302);
      }

      const chipMatch = path.match(/^\/c\/([^/]+)$/);
      if (chipMatch) {
        return handleChipRedirect(chipMatch[1], env, ctx, request);
      }

      if (path.startsWith("/api/")) {
        return handleApi(request, env, path);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return new Response("Error interno", { status: 500 });
    }
  }
};

// ---------- Redirect público (esto es lo que toca el chip físico) ----------

async function handleChipRedirect(slug, env, ctx, request) {
  const fallbackUrl = new URL(FALLBACK_PATH, request.url).toString();

  try {
    if (!env.DB) return Response.redirect(fallbackUrl, 302);

    const row = await env.DB.prepare(
      `SELECT chips.id AS chip_id, chips.destination_url, chips.suspended_url, clients.status
       FROM chips JOIN clients ON chips.client_id = clients.id
       WHERE chips.slug = ?`
    ).bind(slug).first();

    if (!row) return Response.redirect(fallbackUrl, 302);

    ctx.waitUntil(
      env.DB.prepare(`INSERT INTO taps (chip_id) VALUES (?)`).bind(row.chip_id).run().catch(() => {})
    );

    if (row.status === "suspendido") {
      return Response.redirect(row.suspended_url || fallbackUrl, 302);
    }
    if (!row.destination_url) {
      return Response.redirect(fallbackUrl, 302);
    }
    return Response.redirect(row.destination_url, 302);
  } catch (err) {
    console.error(err);
    return Response.redirect(fallbackUrl, 302);
  }
}

// ---------- Helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function getCookieToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/panel_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------- API protegida del panel ----------

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    return apiLogin(request, env);
  }

  if (!env.PANEL_PASSWORD) {
    return json({ error: "Falta configurar la variable PANEL_PASSWORD en el Worker" }, 500);
  }
  if (getCookieToken(request) !== env.PANEL_PASSWORD) {
    return json({ error: "No autorizado" }, 401);
  }

  if (path === "/api/clients" && method === "GET") return apiClientsList(env);
  if (path === "/api/clients" && method === "POST") return apiClientsCreate(request, env);

  const clientId = path.match(/^\/api\/clients\/(\d+)$/);
  if (clientId && method === "GET") return apiClientGet(clientId[1], env);
  if (clientId && method === "PATCH") return apiClientPatch(clientId[1], request, env);
  if (clientId && method === "DELETE") return apiClientDelete(clientId[1], env);

  if (path === "/api/chips" && method === "GET") return apiChipsList(env);
  if (path === "/api/chips" && method === "POST") return apiChipsCreate(request, env);

  const chipId = path.match(/^\/api\/chips\/(\d+)$/);
  if (chipId && method === "PATCH") return apiChipPatch(chipId[1], request, env);

  if (path === "/api/settings" && method === "GET") return apiSettingsGet(env);
  if (path === "/api/settings" && method === "POST") return apiSettingsPost(request, env);

  if (path === "/api/reports/due" && method === "GET") return apiReportsDue(env);

  return json({ error: "Ruta no encontrada" }, 404);
}

async function apiLogin(request, env) {
  if (!env.PANEL_PASSWORD) return json({ error: "Falta configurar PANEL_PASSWORD" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Body inválido" }, 400); }

  if (!body.password || body.password !== env.PANEL_PASSWORD) {
    return json({ error: "Contraseña incorrecta" }, 401);
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `panel_auth=${encodeURIComponent(body.password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function apiClientsList(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM clients ORDER BY due_date ASC`).all();
    return json(results);
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiClientsCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.name || !body.plan || !body.signup_date) {
      return json({ error: "Faltan campos obligatorios: name, plan, signup_date" }, 400);
    }
    const result = await env.DB.prepare(
      `INSERT INTO clients (name, business_type, contact_name, whatsapp, signup_date, plan, billing_freq,
        price_one_time, price_recurring, due_date, status, next_report_date, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.name, body.business_type || null, body.contact_name || null, body.whatsapp || null,
      body.signup_date, body.plan, body.billing_freq || "mensual",
      body.price_one_time ?? null, body.price_recurring ?? null, body.due_date || null,
      body.status || "activo", body.next_report_date || null, body.notes || null
    ).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiClientGet(id, env) {
  try {
    const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?`).bind(id).first();
    if (!client) return json({ error: "Cliente no encontrado" }, 404);
    const { results: chips } = await env.DB.prepare(`SELECT * FROM chips WHERE client_id = ?`).bind(id).all();

    const chipsConToques = [];
    for (const chip of chips) {
      const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM taps WHERE chip_id = ?`).bind(chip.id).first();
      chipsConToques.push({ ...chip, taps_total: countRow ? countRow.total : 0 });
    }

    return json({ ...client, chips: chipsConToques });
  } catch (err) { return json({ error: err.message }, 500); }
}

const CLIENT_EDITABLE = ["name","business_type","contact_name","whatsapp","plan","billing_freq",
  "price_one_time","price_recurring","due_date","status","next_report_date","last_report_sent",
  "last_payment_date","notes"];

async function apiClientPatch(id, request, env) {
  try {
    const body = await request.json();
    const fields = Object.keys(body).filter((k) => CLIENT_EDITABLE.includes(k));
    if (fields.length === 0) return json({ error: "Nada válido para actualizar" }, 400);
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);
    await env.DB.prepare(`UPDATE clients SET ${setClause} WHERE id = ?`).bind(...values, id).run();
    return json({ ok: true });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiClientDelete(id, env) {
  try {
    const { results: chips } = await env.DB.prepare(`SELECT id FROM chips WHERE client_id = ?`).bind(id).all();
    for (const chip of chips) {
      await env.DB.prepare(`DELETE FROM taps WHERE chip_id = ?`).bind(chip.id).run();
    }
    await env.DB.prepare(`DELETE FROM chips WHERE client_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM clients WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiChipsList(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT chips.*, clients.name AS client_name, clients.status AS client_status
       FROM chips JOIN clients ON chips.client_id = clients.id ORDER BY clients.name`
    ).all();
    return json(results);
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiChipsCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.client_id || !body.slug || !body.destination_url) {
      return json({ error: "Faltan campos obligatorios: client_id, slug, destination_url" }, 400);
    }
    const existing = await env.DB.prepare(`SELECT id FROM chips WHERE slug = ?`).bind(body.slug).first();
    if (existing) return json({ error: "Ese slug ya existe, elegí otro" }, 409);
    const result = await env.DB.prepare(
      `INSERT INTO chips (client_id, slug, label, destination_url, suspended_url, password_note)
       VALUES (?,?,?,?,?,?)`
    ).bind(
      body.client_id, body.slug, body.label || null, body.destination_url,
      body.suspended_url || null, body.password_note || null
    ).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiChipPatch(id, request, env) {
  try {
    const body = await request.json();
    const allowed = ["label","destination_url","suspended_url","password_note"];
    const fields = Object.keys(body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return json({ error: "Nada válido para actualizar" }, 400);
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);
    await env.DB.prepare(`UPDATE chips SET ${setClause}, last_reprogrammed = datetime('now') WHERE id = ?`).bind(...values, id).run();
    return json({ ok: true });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiSettingsGet(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    const obj = {};
    results.forEach((r) => { obj[r.key] = r.value; });
    return json(obj);
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiSettingsPost(request, env) {
  try {
    const body = await request.json();
    for (const [key, value] of Object.entries(body)) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, String(value)).run();
    }
    return json({ ok: true });
  } catch (err) { return json({ error: err.message }, 500); }
}

async function apiReportsDue(env) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { results: clients } = await env.DB.prepare(
      `SELECT * FROM clients WHERE next_report_date IS NOT NULL AND next_report_date <= ? AND status != 'suspendido'`
    ).bind(today).all();

    const withCounts = [];
    for (const client of clients) {
      const since = client.last_report_sent || client.signup_date;
      const { results: chipRows } = await env.DB.prepare(`SELECT id, label, slug FROM chips WHERE client_id = ?`).bind(client.id).all();
      const chips = [];
      for (const chip of chipRows) {
        const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM taps WHERE chip_id = ? AND ts >= ?`).bind(chip.id, since).first();
        chips.push({ ...chip, taps_period: countRow ? countRow.total : 0 });
      }
      withCounts.push({ ...client, chips, period_since: since, period_until: today });
    }
    return json(withCounts);
  } catch (err) { return json({ error: err.message }, 500); }
}
