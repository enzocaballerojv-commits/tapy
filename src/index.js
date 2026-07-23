var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

var FALLBACK_PATH = "/error.html";
var index_default = {
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

    const url = new URL(request.url);
    const source = url.searchParams.get("src") || "nfc";

    ctx.waitUntil(
      env.DB.prepare(`INSERT INTO taps (chip_id, source) VALUES (?, ?)`).bind(row.chip_id, source).run().catch(() => {})
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
__name(handleChipRedirect, "handleChipRedirect");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
__name(json, "json");

function getCookieToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/panel_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
__name(getCookieToken, "getCookieToken");

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

  if (path === "/api/chips" && method === "GET") return apiChipsList(request, env);
  if (path === "/api/chips" && method === "POST") return apiChipsCreate(request, env);
  const chipId = path.match(/^\/api\/chips\/(\d+)$/);
  if (chipId && method === "PATCH") return apiChipPatch(chipId[1], request, env);

  if (path === "/api/settings" && method === "GET") return apiSettingsGet(env);
  if (path === "/api/settings" && method === "POST") return apiSettingsPost(request, env);
  if (path === "/api/reports/due" && method === "GET") return apiReportsDue(env);

  if (path === "/api/lotes" && method === "POST") return apiLotesCreate(request, env);
  if (path === "/api/lotes" && method === "GET") return apiLotesList(env);
  const loteExportMatch = path.match(/^\/api\/lotes\/(\d+)\/export$/);
  if (loteExportMatch && method === "GET") return apiLoteExport(loteExportMatch[1], env);

  const chipAsignarMatch = path.match(/^\/api\/chips\/(\d+)\/asignar$/);
  if (chipAsignarMatch && method === "POST") return apiChipAsignar(chipAsignarMatch[1], request, env);
  const chipLiberarMatch = path.match(/^\/api\/chips\/(\d+)\/liberar$/);
  if (chipLiberarMatch && method === "POST") return apiChipLiberar(chipLiberarMatch[1], env);
  const chipDeleteMatch = path.match(/^\/api\/chips\/(\d+)$/);
  if (chipDeleteMatch && method === "DELETE") return apiChipDelete(chipDeleteMatch[1], env);

  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handleApi, "handleApi");

async function apiLogin(request, env) {
  if (!env.PANEL_PASSWORD) return json({ error: "Falta configurar PANEL_PASSWORD" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body invalido" }, 400);
  }
  if (!body.password || body.password !== env.PANEL_PASSWORD) {
    return json({ error: "Contrasena incorrecta" }, 401);
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `panel_auth=${encodeURIComponent(body.password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(apiLogin, "apiLogin");

async function apiClientsList(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM clients ORDER BY due_date ASC`).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiClientsList, "apiClientsList");

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
      body.name,
      body.business_type || null,
      body.contact_name || null,
      body.whatsapp || null,
      body.signup_date,
      body.plan,
      body.billing_freq || "mensual",
      body.price_one_time ?? null,
      body.price_recurring ?? null,
      body.due_date || null,
      body.status || "activo",
      body.next_report_date || null,
      body.notes || null
    ).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiClientsCreate, "apiClientsCreate");

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
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiClientGet, "apiClientGet");

var CLIENT_EDITABLE = [
  "name", "business_type", "contact_name", "whatsapp", "plan", "billing_freq",
  "price_one_time", "price_recurring", "due_date", "status", "next_report_date",
  "last_report_sent", "last_payment_date", "notes"
];
async function apiClientPatch(id, request, env) {
  try {
    const body = await request.json();
    const fields = Object.keys(body).filter((k) => CLIENT_EDITABLE.includes(k));
    if (fields.length === 0) return json({ error: "Nada valido para actualizar" }, 400);
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);
    await env.DB.prepare(`UPDATE clients SET ${setClause} WHERE id = ?`).bind(...values, id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiClientPatch, "apiClientPatch");

async function apiClientDelete(id, env) {
  try {
    const { results: chips } = await env.DB.prepare(`SELECT id FROM chips WHERE client_id = ?`).bind(id).all();
    for (const chip of chips) {
      await env.DB.prepare(`DELETE FROM taps WHERE chip_id = ?`).bind(chip.id).run();
    }
    await env.DB.prepare(`DELETE FROM chips WHERE client_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM clients WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiClientDelete, "apiClientDelete");

async function apiChipsList(request, env) {
  try {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status");
    const loteFilter = url.searchParams.get("lote_id");
    let query = `SELECT chips.*, clients.name AS client_name, clients.status AS client_status,
        clients.contact_name AS client_contact_name, clients.whatsapp AS client_whatsapp
       FROM chips JOIN clients ON chips.client_id = clients.id WHERE 1=1`;
    const binds = [];
    if (statusFilter) {
      query += ` AND chips.status = ?`;
      binds.push(statusFilter);
    }
    if (loteFilter) {
      query += ` AND chips.lote_id = ?`;
      binds.push(loteFilter);
    }
    query += ` ORDER BY clients.name`;
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiChipsList, "apiChipsList");

async function apiChipsCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.client_id || !body.slug || !body.destination_url) {
      return json({ error: "Faltan campos obligatorios: client_id, slug, destination_url" }, 400);
    }
    const existing = await env.DB.prepare(`SELECT id FROM chips WHERE slug = ?`).bind(body.slug).first();
    if (existing) return json({ error: "Ese slug ya existe, elegi otro" }, 409);
    const result = await env.DB.prepare(
      `INSERT INTO chips (client_id, slug, label, destination_url, suspended_url, password_note, status)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      body.client_id,
      body.slug,
      body.label || null,
      body.destination_url,
      body.suspended_url || null,
      body.password_note || null,
      "activo"
    ).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiChipsCreate, "apiChipsCreate");

async function apiChipPatch(id, request, env) {
  try {
    const body = await request.json();
    const allowed = ["label", "destination_url", "suspended_url", "password_note"];
    const fields = Object.keys(body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return json({ error: "Nada valido para actualizar" }, 400);
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);
    await env.DB.prepare(`UPDATE chips SET ${setClause}, last_reprogrammed = datetime('now') WHERE id = ?`).bind(...values, id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiChipPatch, "apiChipPatch");

async function apiSettingsGet(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    const obj = {};
    results.forEach((r) => { obj[r.key] = r.value; });
    return json(obj);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiSettingsGet, "apiSettingsGet");

async function apiSettingsPost(request, env) {
  try {
    const body = await request.json();
    for (const [key, value] of Object.entries(body)) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, String(value)).run();
    }
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiSettingsPost, "apiSettingsPost");

async function apiReportsDue(env) {
  try {
    const today = (new Date()).toISOString().slice(0, 10);
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
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiReportsDue, "apiReportsDue");

function generateSlug(length = 6) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function getStockClientId(env) {
  const row = await env.DB.prepare(`SELECT id FROM clients WHERE name = 'STOCK - Sin Asignar'`).first();
  if (!row) throw new Error("No existe el cliente STOCK - Sin Asignar");
  return row.id;
}

async function apiLotesCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.nombre || !body.cantidad) {
      return json({ error: "Faltan campos obligatorios: nombre, cantidad" }, 400);
    }
    const cantidad = parseInt(body.cantidad, 10);
    if (!cantidad || cantidad < 1 || cantidad > 500) {
      return json({ error: "Cantidad invalida (1-500)" }, 400);
    }
    const stockClientId = await getStockClientId(env);

    const { results: existingRows } = await env.DB.prepare(`SELECT slug FROM chips`).all();
    const existingSlugs = new Set(existingRows.map((r) => r.slug));

    const nuevosSlugs = [];
    let attempts = 0;
    while (nuevosSlugs.length < cantidad) {
      attempts++;
      if (attempts > cantidad * 50) {
        throw new Error("No se pudieron generar suficientes slugs unicos, intenta de nuevo");
      }
      const slug = generateSlug();
      if (!existingSlugs.has(slug) && !nuevosSlugs.includes(slug)) {
        nuevosSlugs.push(slug);
      }
    }

    const loteResult = await env.DB.prepare(
      `INSERT INTO lotes (nombre, total_chips) VALUES (?, ?)`
    ).bind(body.nombre, cantidad).run();
    const loteId = loteResult.meta.last_row_id;

    const statements = nuevosSlugs.map((slug, index) =>
      env.DB.prepare(
        `INSERT INTO chips (client_id, slug, destination_url, lote_id, numero_lote, status)
         VALUES (?, ?, ?, ?, ?, 'sin_asignar')`
      ).bind(stockClientId, slug, "https://tapy.com.py/pendiente-asignacion", loteId, index + 1)
    );
    await env.DB.batch(statements);

    const chips = nuevosSlugs.map((slug, index) => ({ numero_lote: index + 1, slug }));
    return json({ lote_id: loteId, nombre: body.nombre, total_chips: cantidad, chips });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function apiLotesList(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT lotes.*,
        SUM(CASE WHEN chips.status = 'sin_asignar' THEN 1 ELSE 0 END) AS sin_asignar,
        SUM(CASE WHEN chips.status = 'activo' THEN 1 ELSE 0 END) AS activos
       FROM lotes LEFT JOIN chips ON chips.lote_id = lotes.id
       GROUP BY lotes.id ORDER BY lotes.id DESC`
    ).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function apiLoteExport(loteId, env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT chips.id, numero_lote, slug, chips.status, clients.name AS client_name
       FROM chips LEFT JOIN clients ON chips.client_id = clients.id
       WHERE lote_id = ? ORDER BY numero_lote ASC`
    ).bind(loteId).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function apiChipAsignar(chipId, request, env) {
  try {
    const body = await request.json();
    if (!body.client_id || !body.destination_url) {
      return json({ error: "Faltan campos obligatorios: client_id, destination_url" }, 400);
    }
    const chip = await env.DB.prepare(`SELECT status FROM chips WHERE id = ?`).bind(chipId).first();
    if (!chip) return json({ error: "Chip no encontrado" }, 404);
    if (chip.status === "activo" && !body.force) {
      return json({ error: "Este chip ya esta activo y asignado. Manda force:true si queres reasignarlo igual." }, 409);
    }
    await env.DB.prepare(
      `UPDATE chips SET client_id = ?, destination_url = ?, status = 'activo', label = ? WHERE id = ?`
    ).bind(body.client_id, body.destination_url, body.label || null, chipId).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function apiChipLiberar(chipId, env) {
  try {
    const stockClientId = await getStockClientId(env);
    await env.DB.prepare(
      `UPDATE chips SET client_id = ?, destination_url = ?, status = 'sin_asignar', label = NULL WHERE id = ?`
    ).bind(stockClientId, "https://tapy.com.py/pendiente-asignacion", chipId).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function apiChipDelete(id, env) {
  try {
    const chip = await env.DB.prepare(`SELECT status FROM chips WHERE id = ?`).bind(id).first();
    if (!chip) return json({ error: "Chip no encontrado" }, 404);
    if (chip.status === "activo") {
      return json({ error: "Este chip esta activo. Liberalo primero antes de borrarlo." }, 409);
    }
    await env.DB.prepare(`DELETE FROM taps WHERE chip_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM chips WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export {
  index_default as default
};
