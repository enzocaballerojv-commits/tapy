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
      `SELECT chips.id AS chip_id, chips.destination_url, chips.suspended_url, chips.tipo, clients.status
       FROM chips JOIN clients ON chips.client_id = clients.id
       WHERE chips.slug = ?`
    ).bind(slug).first();
    if (!row) return Response.redirect(fallbackUrl, 302);

    // Tarjetas de fidelizacion: no son un simple redirect, tienen su propia pantalla interactiva.
    if (row.tipo === "fidelizacion_inscripcion") {
      return Response.redirect(new URL(`/fidelizacion-inscripcion.html?c=${encodeURIComponent(slug)}`, request.url).toString(), 302);
    }
    if (row.tipo === "fidelizacion_puntos") {
      return Response.redirect(new URL(`/fidelizacion-puntos.html?c=${encodeURIComponent(slug)}`, request.url).toString(), 302);
    }

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

  if (path === "/api/distribuidor/login" && method === "POST") {
    return apiDistribuidorLogin(request, env);
  }
  if (path.startsWith("/api/distribuidor/")) {
    const dist = await requireDistribuidor(request, env);
    if (!dist) return json({ error: "No autorizado" }, 401);
    return handleDistribuidorApi(request, env, path, dist);
  }

  // ---------- FIDELIZACION: publico, sin login (clientes finales tocando su NFC) ----------
  if (path.startsWith("/api/public/fidelizacion/")) {
    return handlePublicFidelizacionApi(request, env, path);
  }

  // ---------- FIDELIZACION: panel del comercio, login propio ----------
  if (path === "/api/comercio/login" && method === "POST") {
    return apiComercioLogin(request, env);
  }
  if (path.startsWith("/api/comercio/")) {
    const comercio = await requireComercio(request, env);
    if (!comercio) return json({ error: "No autorizado" }, 401);
    return handleComercioApi(request, env, path, comercio);
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

  if (path === "/api/distribuidores" && method === "GET") return apiDistribuidoresList(env);
  if (path === "/api/distribuidores" && method === "POST") return apiDistribuidoresCreate(request, env);
  if (path === "/api/chips/transferir" && method === "POST") return apiChipsTransferir(request, env);

  // ---------- FIDELIZACION: panel admin (Tapy) ----------
  if (path === "/api/fidelizacion/chips-libres" && method === "GET") return apiFidChipsLibres(env);
  if (path === "/api/fidelizacion/comercios" && method === "GET") return apiFidComerciosList(env);
  if (path === "/api/fidelizacion/comercios" && method === "POST") return apiFidComercioCreate(request, env);
  const fidComercioMatch = path.match(/^\/api\/fidelizacion\/comercios\/(\d+)$/);
  if (fidComercioMatch && method === "PATCH") return apiFidComercioPatch(fidComercioMatch[1], request, env);
  if (fidComercioMatch && method === "DELETE") return apiFidComercioDelete(fidComercioMatch[1], env);
  const fidPremiosMatch = path.match(/^\/api\/fidelizacion\/comercios\/(\d+)\/premios$/);
  if (fidPremiosMatch && method === "PATCH") return apiFidPremiosPatch(fidPremiosMatch[1], request, env);
  if (fidPremiosMatch && method === "GET") return apiFidPremiosGet(fidPremiosMatch[1], env);
  const fidEstadoMatch = path.match(/^\/api\/fidelizacion\/comercios\/(\d+)\/estado$/);
  if (fidEstadoMatch && method === "POST") return apiFidComercioEstado(fidEstadoMatch[1], request, env);
  const fidClientesMatch = path.match(/^\/api\/fidelizacion\/comercios\/(\d+)\/clientes$/);
  if (fidClientesMatch && method === "GET") return apiFidComercioClientes(fidClientesMatch[1], env);

  // ---------- COBROS: panel admin (Tapy) ----------
  if (path === "/api/cobros" && method === "GET") return apiCobrosList(env);
  const cobroSolicitarMatch = path.match(/^\/api\/cobros\/(\d+)\/solicitar$/);
  if (cobroSolicitarMatch && method === "POST") return apiCobroSolicitar(cobroSolicitarMatch[1], env);
  const cobroPagadoMatch = path.match(/^\/api\/cobros\/(\d+)\/pagado$/);
  if (cobroPagadoMatch && method === "POST") return apiCobroPagado(cobroPagadoMatch[1], env);

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
    const comercio = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios WHERE client_id = ?`).bind(id).first();
    if (comercio) {
      // El cliente se borra igual mas abajo, asi que no hace falta liberar sus chips a stock: ya se van a borrar.
      await eliminarFidelizacionComercio(env, comercio.id, false);
    }

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
        clients.contact_name AS client_contact_name, clients.whatsapp AS client_whatsapp,
        distribuidores.nombre AS distribuidor_nombre,
        COALESCE(taps_agg.taps_total, 0) AS taps_total,
        COALESCE(taps_agg.taps_nfc, 0) AS taps_nfc,
        COALESCE(taps_agg.taps_qr, 0) AS taps_qr
       FROM chips
       JOIN clients ON chips.client_id = clients.id
       LEFT JOIN distribuidores ON chips.distribuidor_id = distribuidores.id
       LEFT JOIN (
         SELECT chip_id,
           COUNT(*) AS taps_total,
           SUM(CASE WHEN source = 'nfc' THEN 1 ELSE 0 END) AS taps_nfc,
           SUM(CASE WHEN source = 'qr' THEN 1 ELSE 0 END) AS taps_qr
         FROM taps
         GROUP BY chip_id
       ) taps_agg ON taps_agg.chip_id = chips.id
       WHERE 1=1`;
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

    const maxRow = await env.DB.prepare(`SELECT MAX(numero_lote) AS max_numero FROM chips`).first();
    const startNumero = (maxRow && maxRow.max_numero ? maxRow.max_numero : 0) + 1;

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
      ).bind(stockClientId, slug, "https://tapy.com.py/pendiente-asignacion", loteId, startNumero + index)
    );
    await env.DB.batch(statements);

    const chips = nuevosSlugs.map((slug, index) => ({ numero_lote: startNumero + index, slug }));
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


// ---------- MAYORISTAS / DISTRIBUIDORES ----------

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");

function getDistribuidorCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/distribuidor_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
__name(getDistribuidorCookie, "getDistribuidorCookie");

async function requireDistribuidor(request, env) {
  const token = getDistribuidorCookie(request);
  if (!token) return null;
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [idStr, hash] = parts;
  const dist = await env.DB.prepare(`SELECT * FROM distribuidores WHERE id = ?`).bind(idStr).first();
  if (!dist || dist.password_hash !== hash) return null;
  return dist;
}
__name(requireDistribuidor, "requireDistribuidor");

async function apiDistribuidorLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body invalido" }, 400);
  }
  if (!body.usuario || !body.password) return json({ error: "Faltan usuario y contrasena" }, 400);
  const dist = await env.DB.prepare(`SELECT * FROM distribuidores WHERE usuario = ?`).bind(body.usuario).first();
  if (!dist) return json({ error: "Usuario o contrasena incorrectos" }, 401);
  const hash = await sha256Hex(body.password);
  if (hash !== dist.password_hash) return json({ error: "Usuario o contrasena incorrectos" }, 401);
  const token = `${dist.id}:${hash}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `distribuidor_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  return new Response(JSON.stringify({ ok: true, nombre: dist.nombre }), { status: 200, headers });
}
__name(apiDistribuidorLogin, "apiDistribuidorLogin");

async function apiDistribuidoresList(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT id, nombre, usuario, created_at FROM distribuidores ORDER BY nombre`).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiDistribuidoresList, "apiDistribuidoresList");

async function apiDistribuidoresCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.nombre || !body.usuario || !body.password) {
      return json({ error: "Faltan campos obligatorios: nombre, usuario, password" }, 400);
    }
    const existing = await env.DB.prepare(`SELECT id FROM distribuidores WHERE usuario = ?`).bind(body.usuario).first();
    if (existing) return json({ error: "Ese usuario ya existe, elegi otro" }, 409);
    const hash = await sha256Hex(body.password);
    const result = await env.DB.prepare(
      `INSERT INTO distribuidores (nombre, usuario, password_hash) VALUES (?,?,?)`
    ).bind(body.nombre, body.usuario, hash).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiDistribuidoresCreate, "apiDistribuidoresCreate");

async function apiChipsTransferir(request, env) {
  try {
    const body = await request.json();
    const chipIds = Array.isArray(body.chip_ids) ? body.chip_ids.filter((n) => Number.isInteger(n) || /^\d+$/.test(n)) : [];
    if (!chipIds.length) return json({ error: "No se especificaron chips para transferir" }, 400);
    const distribuidorId = body.distribuidor_id || null;
    if (distribuidorId) {
      const dist = await env.DB.prepare(`SELECT id FROM distribuidores WHERE id = ?`).bind(distribuidorId).first();
      if (!dist) return json({ error: "Distribuidor no encontrado" }, 404);
    }
    const statements = chipIds.map((id) =>
      env.DB.prepare(`UPDATE chips SET distribuidor_id = ? WHERE id = ?`).bind(distribuidorId, id)
    );
    await env.DB.batch(statements);
    return json({ ok: true, total: chipIds.length });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiChipsTransferir, "apiChipsTransferir");

async function chipBelongsToDistribuidor(env, chipId, distribuidorId) {
  const row = await env.DB.prepare(
    `SELECT id FROM chips WHERE id = ? AND distribuidor_id = ?`
  ).bind(chipId, distribuidorId).first();
  return !!row;
}
__name(chipBelongsToDistribuidor, "chipBelongsToDistribuidor");

async function handleDistribuidorApi(request, env, path, dist) {
  const method = request.method;
  const url = new URL(request.url);

  if (path === "/api/distribuidor/me" && method === "GET") {
    return json({ id: dist.id, nombre: dist.nombre });
  }

  if (path === "/api/distribuidor/settings" && method === "GET") {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'dominio_activo'`).first();
    return json({ dominio_activo: row ? row.value : null });
  }

  if (path === "/api/distribuidor/lotes" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT lotes.id, lotes.nombre, lotes.total_chips, lotes.created_at,
        SUM(CASE WHEN chips.status = 'sin_asignar' THEN 1 ELSE 0 END) AS sin_asignar,
        SUM(CASE WHEN chips.status = 'activo' THEN 1 ELSE 0 END) AS activos
       FROM chips JOIN lotes ON chips.lote_id = lotes.id
       WHERE chips.distribuidor_id = ?
       GROUP BY lotes.id ORDER BY lotes.id DESC`
    ).bind(dist.id).all();
    return json(results);
  }

  if (path === "/api/distribuidor/chips" && method === "GET") {
    const statusFilter = url.searchParams.get("status");
    const loteFilter = url.searchParams.get("lote_id");
    let query = `SELECT chips.*, clients.name AS client_name, clients.status AS client_status,
        clients.contact_name AS client_contact_name, clients.whatsapp AS client_whatsapp,
        COALESCE(taps_agg.taps_total, 0) AS taps_total,
        COALESCE(taps_agg.taps_nfc, 0) AS taps_nfc,
        COALESCE(taps_agg.taps_qr, 0) AS taps_qr
       FROM chips
       JOIN clients ON chips.client_id = clients.id
       LEFT JOIN (
         SELECT chip_id, COUNT(*) AS taps_total,
           SUM(CASE WHEN source = 'nfc' THEN 1 ELSE 0 END) AS taps_nfc,
           SUM(CASE WHEN source = 'qr' THEN 1 ELSE 0 END) AS taps_qr
         FROM taps GROUP BY chip_id
       ) taps_agg ON taps_agg.chip_id = chips.id
       WHERE chips.distribuidor_id = ?`;
    const binds = [dist.id];
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
  }

  const chipAsignarMatch = path.match(/^\/api\/distribuidor\/chips\/(\d+)\/asignar$/);
  if (chipAsignarMatch && method === "POST") {
    const chipId = chipAsignarMatch[1];
    const owns = await chipBelongsToDistribuidor(env, chipId, dist.id);
    if (!owns) return json({ error: "Ese chip no pertenece a tu inventario" }, 403);
    return apiChipAsignar(chipId, request, env);
  }

  const chipLiberarMatch = path.match(/^\/api\/distribuidor\/chips\/(\d+)\/liberar$/);
  if (chipLiberarMatch && method === "POST") {
    const chipId = chipLiberarMatch[1];
    const owns = await chipBelongsToDistribuidor(env, chipId, dist.id);
    if (!owns) return json({ error: "Ese chip no pertenece a tu inventario" }, 403);
    return apiChipLiberar(chipId, env);
  }

  if (path === "/api/distribuidor/clients" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT clients.* FROM clients
       JOIN chips ON chips.client_id = clients.id
       WHERE chips.distribuidor_id = ?`
    ).bind(dist.id).all();
    return json(results);
  }
  if (path === "/api/distribuidor/clients" && method === "POST") {
    return apiClientsCreate(request, env);
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handleDistribuidorApi, "handleDistribuidorApi");


// ======================================================================
// FIDELIZACION — programa de puntos/niveles por comercio
// ======================================================================

var GRACIA_DIAS = 3;
var TAP_RATE_LIMIT_HOURS = 4; // valor de respaldo si el comercio todavia no tiene horas_entre_sumas cargado

async function signWithSecret(env, text) {
  return sha256Hex(`${text}:${env.PANEL_PASSWORD || ""}`);
}
__name(signWithSecret, "signWithSecret");

// ---------- login y cookie del panel del comercio ----------

function getComercioCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/comercio_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
__name(getComercioCookie, "getComercioCookie");

async function requireComercio(request, env) {
  const token = getComercioCookie(request);
  if (!token) return null;
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [idStr, hash] = parts;
  const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE id = ?`).bind(idStr).first();
  if (!comercio || !comercio.password_hash || comercio.password_hash !== hash) return null;
  return comercio;
}
__name(requireComercio, "requireComercio");

async function apiComercioLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body invalido" }, 400);
  }
  if (!body.usuario || !body.password) return json({ error: "Faltan usuario y contraseña" }, 400);
  const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE usuario = ?`).bind(body.usuario).first();
  if (!comercio) return json({ error: "Usuario o contraseña incorrectos" }, 401);
  const hash = await sha256Hex(body.password);
  if (hash !== comercio.password_hash) return json({ error: "Usuario o contraseña incorrectos" }, 401);
  const token = `${comercio.id}:${hash}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `comercio_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(apiComercioLogin, "apiComercioLogin");

// ---------- sesion (cookie) del cliente final, anonima, firmada ----------

function getFidSessionCookie(request, comercioId) {
  const cookie = request.headers.get("Cookie") || "";
  const re = new RegExp(`fid_${comercioId}=([^;]+)`);
  const match = cookie.match(re);
  return match ? decodeURIComponent(match[1]) : null;
}
__name(getFidSessionCookie, "getFidSessionCookie");

async function buildFidSessionCookie(env, comercioId, clienteId) {
  const hash = await signWithSecret(env, `${comercioId}:${clienteId}`);
  return `fid_${comercioId}=${encodeURIComponent(`${clienteId}:${hash}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}
__name(buildFidSessionCookie, "buildFidSessionCookie");

async function getFidClienteIdFromCookie(request, env, comercioId) {
  const token = getFidSessionCookie(request, comercioId);
  if (!token) return null;
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [clienteIdStr, hash] = parts;
  const expected = await signWithSecret(env, `${comercioId}:${clienteIdStr}`);
  if (expected !== hash) return null;
  return clienteIdStr;
}
__name(getFidClienteIdFromCookie, "getFidClienteIdFromCookie");

// ---------- bloqueo automatico por falta de pago ----------

async function checkAndUpdateComercioEstado(env, comercioId) {
  const comercio = await env.DB.prepare(`SELECT id, estado FROM fidelizacion_comercios WHERE id = ?`).bind(comercioId).first();
  if (!comercio) return null;
  if (comercio.estado === "suspendido") return "suspendido";
  const cobro = await env.DB.prepare(
    `SELECT id, fecha_solicitud_enviada FROM fidelizacion_cobros
     WHERE comercio_id = ? AND estado = 'solicitado' AND fecha_solicitud_enviada IS NOT NULL
     ORDER BY fecha_vencimiento DESC LIMIT 1`
  ).bind(comercioId).first();
  if (cobro) {
    const limite = new Date(cobro.fecha_solicitud_enviada);
    limite.setDate(limite.getDate() + GRACIA_DIAS);
    if (new Date() > limite) {
      await env.DB.prepare(`UPDATE fidelizacion_cobros SET estado = 'vencido_suspendido' WHERE id = ?`).bind(cobro.id).run();
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET estado = 'suspendido' WHERE id = ?`).bind(comercioId).run();
      return "suspendido";
    }
  }
  return "activo";
}
__name(checkAndUpdateComercioEstado, "checkAndUpdateComercioEstado");

// ---------- endpoints publicos (clientes finales, sin login) ----------

async function handlePublicFidelizacionApi(request, env, path) {
  const method = request.method;
  if (path === "/api/public/fidelizacion/info" && method === "GET") {
    return apiPublicComercioInfo(request, env);
  }
  if (path === "/api/public/fidelizacion/inscribir" && method === "POST") {
    return apiPublicInscribir(request, env);
  }
  if (path === "/api/public/fidelizacion/estado" && method === "GET") {
    return apiPublicEstado(request, env);
  }
  if (path === "/api/public/fidelizacion/sumar" && method === "POST") {
    return apiPublicSumar(request, env);
  }
  if (path === "/api/public/fidelizacion/recuperar-sesion" && method === "POST") {
    return apiPublicRecuperarSesion(request, env);
  }
  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handlePublicFidelizacionApi, "handlePublicFidelizacionApi");

async function findComercioByChipSlugYTipo(env, slug, tipo) {
  return env.DB.prepare(
    `SELECT fidelizacion_comercios.*, clients.name AS comercio_nombre, chips.id AS chip_id
     FROM chips JOIN fidelizacion_comercios
       ON (chips.tipo = 'fidelizacion_inscripcion' AND fidelizacion_comercios.nfc_inscripcion_chip_id = chips.id)
       OR (chips.tipo = 'fidelizacion_puntos' AND fidelizacion_comercios.nfc_puntos_chip_id = chips.id)
     JOIN clients ON clients.id = fidelizacion_comercios.client_id
     WHERE chips.slug = ? AND chips.tipo = ?`
  ).bind(slug, tipo).first();
}
__name(findComercioByChipSlugYTipo, "findComercioByChipSlugYTipo");

async function apiPublicComercioInfo(request, env) {
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    const tipoParam = url.searchParams.get("tipo") === "puntos" ? "fidelizacion_puntos" : "fidelizacion_inscripcion";
    if (!slug) return json({ error: "Falta el parametro slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, tipoParam);
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);
    return json({ nombre: comercio.comercio_nombre, activo: comercio.estado === "activo" });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicComercioInfo, "apiPublicComercioInfo");

function normalizarWhatsapp(raw) {
  // Guarda siempre el mismo formato sin importar como lo haya tipeado el cliente:
  // "0981613925", "981 613 925", "+595981613925" y "595981613925" quedan todos como "981613925".
  let limpio = String(raw || "").replace(/[^\d]/g, "");
  if (limpio.startsWith("595")) limpio = limpio.slice(3);
  if (limpio.startsWith("0")) limpio = limpio.slice(1);
  return limpio;
}
__name(normalizarWhatsapp, "normalizarWhatsapp");

async function apiPublicInscribir(request, env) {
  try {
    const body = await request.json();
    const { slug, nombre, acepta } = body;
    const whatsapp = normalizarWhatsapp(body.whatsapp);
    if (!slug || !nombre || !whatsapp || !acepta) {
      return json({ error: "Faltan datos: nombre, whatsapp y la aceptación son obligatorios" }, 400);
    }
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_inscripcion");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") {
      return json({ error: "suspendido", mensaje: "Este comercio no tiene el club de fidelidad activo en este momento." }, 403);
    }

    let cliente = await env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? AND whatsapp = ?`
    ).bind(comercio.id, whatsapp).first();

    if (!cliente) {
      const result = await env.DB.prepare(
        `INSERT INTO fidelizacion_clientes (comercio_id, nombre, whatsapp) VALUES (?, ?, ?)`
      ).bind(comercio.id, nombre, whatsapp).run();
      cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ?`).bind(result.meta.last_row_id).first();
    } else if (cliente.nombre !== nombre) {
      await env.DB.prepare(`UPDATE fidelizacion_clientes SET nombre = ? WHERE id = ?`).bind(nombre, cliente.id).run();
      cliente.nombre = nombre;
    }

    const cookieValue = await buildFidSessionCookie(env, comercio.id, cliente.id);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", cookieValue);
    return new Response(JSON.stringify({
      ok: true,
      nombre: cliente.nombre,
      negocio_nombre: comercio.comercio_nombre,
      nivel_actual: cliente.nivel_actual,
      monedas_actuales: cliente.monedas_actuales,
      monedas_por_nivel: comercio.monedas_por_nivel
    }), { status: 200, headers });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicInscribir, "apiPublicInscribir");

async function estadoClienteRespuesta(env, comercio, cliente) {
  const premio = await env.DB.prepare(
    `SELECT descripcion FROM fidelizacion_premios WHERE comercio_id = ? AND nivel = ?`
  ).bind(comercio.id, cliente.nivel_actual).first();
  return {
    ok: true,
    nombre: cliente.nombre,
    negocio_nombre: comercio.comercio_nombre,
    nivel_actual: cliente.nivel_actual,
    monedas_actuales: cliente.monedas_actuales,
    monedas_por_nivel: comercio.monedas_por_nivel,
    niveles: comercio.niveles,
    pendiente_canje: !!cliente.pendiente_canje,
    premio_nivel_actual: premio ? premio.descripcion : null
  };
}
__name(estadoClienteRespuesta, "estadoClienteRespuesta");

async function apiPublicEstado(request, env) {
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return json({ error: "Falta el parametro slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_puntos");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") {
      return json({ error: "suspendido", mensaje: "Este comercio no tiene el club de fidelidad activo en este momento." }, 403);
    }

    const clienteId = await getFidClienteIdFromCookie(request, env, comercio.id);
    if (!clienteId) return json({ needsWhatsapp: true, negocio_nombre: comercio.comercio_nombre });

    const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
    if (!cliente) return json({ needsWhatsapp: true, negocio_nombre: comercio.comercio_nombre });

    return json(await estadoClienteRespuesta(env, comercio, cliente));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicEstado, "apiPublicEstado");

async function intentarSumarMoneda(env, comercio, cliente) {
  if (cliente.pendiente_canje) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)), nivel_completo: true };
  }
  // Cada comercio elige su propio lapso entre sumas (ej: un bar puede poner 0 para instantaneo,
  // un restaurante puede poner 24 para una vez por dia). horas_entre_sumas admite decimales
  // (0.5 = 30 minutos). Si el comercio todavia no tiene el campo cargado, usamos el valor de respaldo.
  const horasEspera = (comercio.horas_entre_sumas === null || comercio.horas_entre_sumas === undefined)
    ? TAP_RATE_LIMIT_HOURS
    : Number(comercio.horas_entre_sumas);
  if (horasEspera > 0) {
    const ultimaTap = await env.DB.prepare(
      `SELECT ts FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ? ORDER BY ts DESC LIMIT 1`
    ).bind(cliente.id).first();
    if (ultimaTap) {
      const limite = new Date(new Date(ultimaTap.ts).getTime() + horasEspera * 3600000);
      if (new Date() < limite) {
        return { ...(await estadoClienteRespuesta(env, comercio, cliente)), ya_sumaste: true };
      }
    }
  }
  let nuevasMonedas = cliente.monedas_actuales + 1;
  let nuevoPendiente = 0;
  if (nuevasMonedas >= comercio.monedas_por_nivel) {
    nuevasMonedas = comercio.monedas_por_nivel;
    nuevoPendiente = 1;
  }
  await env.DB.prepare(
    `UPDATE fidelizacion_clientes SET monedas_actuales = ?, pendiente_canje = ?, ultimo_tap = datetime('now') WHERE id = ?`
  ).bind(nuevasMonedas, nuevoPendiente, cliente.id).run();
  await env.DB.prepare(`INSERT INTO fidelizacion_taps (fidelizacion_cliente_id) VALUES (?)`).bind(cliente.id).run();

  cliente.monedas_actuales = nuevasMonedas;
  cliente.pendiente_canje = nuevoPendiente;
  return { ...(await estadoClienteRespuesta(env, comercio, cliente)), sumo_moneda: true, nivel_completo: !!nuevoPendiente };
}
__name(intentarSumarMoneda, "intentarSumarMoneda");

async function apiPublicSumar(request, env) {
  try {
    const body = await request.json();
    const slug = body.slug;
    if (!slug) return json({ error: "Falta el slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_puntos");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") {
      return json({ error: "suspendido", mensaje: "Este comercio no tiene el club de fidelidad activo en este momento." }, 403);
    }

    const clienteId = await getFidClienteIdFromCookie(request, env, comercio.id);
    if (!clienteId) return json({ needsWhatsapp: true, negocio_nombre: comercio.comercio_nombre });
    const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
    if (!cliente) return json({ needsWhatsapp: true, negocio_nombre: comercio.comercio_nombre });

    return json(await intentarSumarMoneda(env, comercio, cliente));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicSumar, "apiPublicSumar");

async function apiPublicRecuperarSesion(request, env) {
  try {
    const body = await request.json();
    const { slug } = body;
    const whatsapp = normalizarWhatsapp(body.whatsapp);
    if (!slug || !whatsapp) return json({ error: "Falta el whatsapp" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_puntos");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") {
      return json({ error: "suspendido", mensaje: "Este comercio no tiene el club de fidelidad activo en este momento." }, 403);
    }

    const cliente = await env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? AND whatsapp = ?`
    ).bind(comercio.id, whatsapp).first();
    if (!cliente) {
      return json({ error: "no_encontrado", mensaje: "No encontramos ese WhatsApp. Pedí que te inscriban con la otra tarjeta primero." }, 404);
    }

    const cookieValue = await buildFidSessionCookie(env, comercio.id, cliente.id);
    const resultado = await intentarSumarMoneda(env, comercio, cliente);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", cookieValue);
    return new Response(JSON.stringify(resultado), { status: 200, headers });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicRecuperarSesion, "apiPublicRecuperarSesion");

// ---------- endpoints admin (panel de Enzo) ----------

async function generarSlugUnico(env) {
  const { results: existingRows } = await env.DB.prepare(`SELECT slug FROM chips`).all();
  const existingSlugs = new Set(existingRows.map((r) => r.slug));
  let slug;
  let attempts = 0;
  do {
    slug = generateSlug();
    attempts++;
    if (attempts > 200) throw new Error("No se pudo generar un slug unico");
  } while (existingSlugs.has(slug));
  return slug;
}
__name(generarSlugUnico, "generarSlugUnico");

// Borra por completo el programa de fidelización de un comercio (clientes, premios,
// toques, canjes y cobros) y, si se pide, libera sus 2 chips NFC/QR de vuelta al stock
// (sin_asignar, tipo 'resena') para que se puedan volver a usar en otro comercio.
async function eliminarFidelizacionComercio(env, comercioId, liberarChips) {
  const comercio = await env.DB.prepare(
    `SELECT id, nfc_inscripcion_chip_id, nfc_puntos_chip_id FROM fidelizacion_comercios WHERE id = ?`
  ).bind(comercioId).first();
  if (!comercio) return;

  const { results: clientes } = await env.DB.prepare(
    `SELECT id FROM fidelizacion_clientes WHERE comercio_id = ?`
  ).bind(comercioId).all();
  for (const c of clientes) {
    await env.DB.prepare(`DELETE FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ?`).bind(c.id).run();
    await env.DB.prepare(`DELETE FROM fidelizacion_canjes WHERE fidelizacion_cliente_id = ?`).bind(c.id).run();
  }
  await env.DB.prepare(`DELETE FROM fidelizacion_clientes WHERE comercio_id = ?`).bind(comercioId).run();
  await env.DB.prepare(`DELETE FROM fidelizacion_premios WHERE comercio_id = ?`).bind(comercioId).run();
  await env.DB.prepare(`DELETE FROM fidelizacion_cobros WHERE comercio_id = ?`).bind(comercioId).run();

  if (liberarChips) {
    const stockClientId = await getStockClientId(env);
    const chipIds = [comercio.nfc_inscripcion_chip_id, comercio.nfc_puntos_chip_id].filter(Boolean);
    for (const chipId of chipIds) {
      await env.DB.prepare(
        `UPDATE chips SET client_id = ?, destination_url = ?, status = 'sin_asignar', tipo = 'resena', label = NULL WHERE id = ?`
      ).bind(stockClientId, "https://tapy.com.py/pendiente-asignacion", chipId).run();
    }
  }

  await env.DB.prepare(`DELETE FROM fidelizacion_comercios WHERE id = ?`).bind(comercioId).run();
}
__name(eliminarFidelizacionComercio, "eliminarFidelizacionComercio");

async function apiFidComercioDelete(id, env) {
  try {
    const comercio = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios WHERE id = ?`).bind(id).first();
    if (!comercio) return json({ error: "Comercio no encontrado" }, 404);
    await eliminarFidelizacionComercio(env, id, true);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioDelete, "apiFidComercioDelete");

async function apiFidChipsLibres(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, slug, numero_lote FROM chips WHERE status = 'sin_asignar' ORDER BY numero_lote ASC, id ASC`
    ).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidChipsLibres, "apiFidChipsLibres");

// Valida (sin escribir nada todavia) que un chip elegido de stock exista y este libre.
// Se corre ANTES de crear el comercio, para no dejar filas a medio crear si algo falla.
async function validarChipFidelizacion(env, chipId) {
  if (!chipId) return null; // sin chipId: se genera uno virtual mas adelante, nada que validar
  const chip = await env.DB.prepare(`SELECT id, slug, status FROM chips WHERE id = ?`).bind(chipId).first();
  if (!chip) throw new Error("No encontramos ese chip");
  if (chip.status !== "sin_asignar") throw new Error("Ese chip ya no está libre, elegí otro");
  return chip;
}
__name(validarChipFidelizacion, "validarChipFidelizacion");

// Reclama UNA tarjeta (inscripción o puntos) ya validada: si viene un chip de stock, lo
// asigna; si no, genera uno virtual nuevo. Solo se llama despues de crear el comercio.
async function reclamarChipFidelizacion(env, clientId, chipValidado, tipoChip, labelTexto) {
  if (chipValidado) {
    await env.DB.prepare(
      `UPDATE chips SET client_id = ?, destination_url = ?, status = 'activo', tipo = ?, label = ? WHERE id = ?`
    ).bind(clientId, "https://tapy.com.py/fidelizacion", tipoChip, labelTexto, chipValidado.id).run();
    return { id: chipValidado.id, slug: chipValidado.slug };
  }
  const slug = await generarSlugUnico(env);
  const result = await env.DB.prepare(
    `INSERT INTO chips (client_id, slug, destination_url, status, tipo) VALUES (?,?,?, 'activo', ?)`
  ).bind(clientId, slug, "https://tapy.com.py/fidelizacion", tipoChip).run();
  return { id: result.meta.last_row_id, slug };
}
__name(reclamarChipFidelizacion, "reclamarChipFidelizacion");

async function apiFidComerciosList(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT fidelizacion_comercios.*, clients.name AS client_name, clients.whatsapp AS client_whatsapp,
        chip_i.slug AS slug_inscripcion, chip_p.slug AS slug_puntos,
        (SELECT COUNT(*) FROM fidelizacion_clientes WHERE fidelizacion_clientes.comercio_id = fidelizacion_comercios.id) AS clientes_total,
        (SELECT COUNT(*) FROM fidelizacion_clientes WHERE fidelizacion_clientes.comercio_id = fidelizacion_comercios.id AND pendiente_canje = 1) AS pendientes_canje
       FROM fidelizacion_comercios
       JOIN clients ON fidelizacion_comercios.client_id = clients.id
       LEFT JOIN chips chip_i ON chip_i.id = fidelizacion_comercios.nfc_inscripcion_chip_id
       LEFT JOIN chips chip_p ON chip_p.id = fidelizacion_comercios.nfc_puntos_chip_id
       ORDER BY clients.name`
    ).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComerciosList, "apiFidComerciosList");

async function apiFidComercioCreate(request, env) {
  try {
    const body = await request.json();
    if (!body.client_id) return json({ error: "Falta client_id" }, 400);
    const existing = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios WHERE client_id = ?`).bind(body.client_id).first();
    if (existing) return json({ error: "Ese comercio ya tiene fidelizacion activada" }, 409);
    if (!body.usuario || !body.password) return json({ error: "Falta usuario y contraseña para el panel del comercio" }, 400);
    const existingUser = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios WHERE usuario = ?`).bind(body.usuario).first();
    if (existingUser) return json({ error: "Ese usuario ya existe, elegi otro" }, 409);

    // Validamos TODO (incluidas las 2 tarjetas) antes de escribir nada en la base: si algo
    // de esto falla, no queremos dejar un comercio a medio crear que despues bloquee un
    // segundo intento (usuario/empresa ya "ocupados" por una fila fantasma).
    if (body.chip_inscripcion_id && body.chip_puntos_id && String(body.chip_inscripcion_id) === String(body.chip_puntos_id)) {
      return json({ error: "Elegí 2 chips distintos para inscripción y puntos" }, 400);
    }
    let chipInsValidado, chipPunValidado;
    try {
      chipInsValidado = await validarChipFidelizacion(env, body.chip_inscripcion_id);
      chipPunValidado = await validarChipFidelizacion(env, body.chip_puntos_id);
    } catch (err) {
      return json({ error: err.message }, 409);
    }

    const niveles = parseInt(body.niveles, 10) || 5;
    const monedasPorNivel = parseInt(body.monedas_por_nivel, 10) || 10;
    const validezDias = parseInt(body.validez_dias, 10) || 90;
    const horasEntreSumas = (body.horas_entre_sumas === undefined || body.horas_entre_sumas === null || body.horas_entre_sumas === "")
      ? 4 : parseFloat(body.horas_entre_sumas);
    const passwordHash = await sha256Hex(body.password);

    const result = await env.DB.prepare(
      `INSERT INTO fidelizacion_comercios (client_id, usuario, password_hash, niveles, monedas_por_nivel, validez_dias, horas_entre_sumas)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(body.client_id, body.usuario, passwordHash, niveles, monedasPorNivel, validezDias, horasEntreSumas).run();
    const comercioId = result.meta.last_row_id;

    const premios = Array.isArray(body.premios) ? body.premios : [];
    if (premios.length) {
      const statements = premios.map((p) =>
        env.DB.prepare(`INSERT INTO fidelizacion_premios (comercio_id, nivel, descripcion) VALUES (?,?,?)`)
          .bind(comercioId, p.nivel, p.descripcion)
      );
      await env.DB.batch(statements);
    }

    // El comercio puede elegir, para cada una de las 2 tarjetas por separado, un chip ya
    // impreso (NFC+QR) de su stock libre (control de inventario), o dejar que el sistema
    // le genere un chip virtual nuevo. Cada tarjeta se resuelve de forma independiente.
    const chipIns = await reclamarChipFidelizacion(env, body.client_id, chipInsValidado, "fidelizacion_inscripcion", "Fidelizacion - inscripcion");
    const chipPun = await reclamarChipFidelizacion(env, body.client_id, chipPunValidado, "fidelizacion_puntos", "Fidelizacion - puntos");
    const slugInscripcion = chipIns.slug;
    const slugPuntos = chipPun.slug;

    await env.DB.prepare(
      `UPDATE fidelizacion_comercios SET nfc_inscripcion_chip_id = ?, nfc_puntos_chip_id = ? WHERE id = ?`
    ).bind(chipIns.id, chipPun.id, comercioId).run();

    const fechaVencimiento = new Date();
    fechaVencimiento.setMonth(fechaVencimiento.getMonth() + 2);
    await env.DB.prepare(
      `INSERT INTO fidelizacion_cobros (comercio_id, periodo, monto, fecha_vencimiento, estado)
       VALUES (?, ?, ?, ?, 'pendiente')`
    ).bind(comercioId, fechaVencimiento.toISOString().slice(0, 7), body.monto_mensual || null, fechaVencimiento.toISOString().slice(0, 10)).run();

    return json({ id: comercioId, slug_inscripcion: slugInscripcion, slug_puntos: slugPuntos });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioCreate, "apiFidComercioCreate");

var FID_COMERCIO_EDITABLE = ["niveles", "monedas_por_nivel", "horas_entre_sumas"];
async function apiFidComercioPatch(id, request, env) {
  try {
    const body = await request.json();
    const fields = [];
    const values = [];
    for (const key of FID_COMERCIO_EDITABLE) {
      if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]); }
    }
    if (body.validez_dias !== undefined) {
      fields.push("validez_dias = ?");
      values.push(body.validez_dias);
    }
    if (body.resetear_bloqueo_validez) {
      fields.push("validez_editada_por_comercio = 0");
    }
    if (body.monto_mensual !== undefined) {
      await env.DB.prepare(
        `UPDATE fidelizacion_cobros SET monto = ? WHERE comercio_id = ? AND estado = 'pendiente'`
      ).bind(body.monto_mensual, id).run();
    }
    if (!fields.length) return json({ ok: true });
    values.push(id);
    await env.DB.prepare(`UPDATE fidelizacion_comercios SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioPatch, "apiFidComercioPatch");

async function apiFidPremiosGet(comercioId, env) {
  try {
    const { results } = await env.DB.prepare(`SELECT nivel, descripcion FROM fidelizacion_premios WHERE comercio_id = ? ORDER BY nivel`).bind(comercioId).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidPremiosGet, "apiFidPremiosGet");

async function apiFidPremiosPatch(comercioId, request, env) {
  try {
    const body = await request.json();
    const premios = Array.isArray(body.premios) ? body.premios : [];
    const statements = premios.map((p) =>
      env.DB.prepare(
        `INSERT INTO fidelizacion_premios (comercio_id, nivel, descripcion) VALUES (?,?,?)
         ON CONFLICT(comercio_id, nivel) DO UPDATE SET descripcion = excluded.descripcion`
      ).bind(comercioId, p.nivel, p.descripcion)
    );
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidPremiosPatch, "apiFidPremiosPatch");

async function apiFidComercioEstado(id, request, env) {
  try {
    const body = await request.json();
    if (body.estado !== "activo" && body.estado !== "suspendido") {
      return json({ error: "Estado invalido" }, 400);
    }
    await env.DB.prepare(`UPDATE fidelizacion_comercios SET estado = ? WHERE id = ?`).bind(body.estado, id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioEstado, "apiFidComercioEstado");

async function apiFidComercioClientes(comercioId, env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? ORDER BY pendiente_canje DESC, monedas_actuales DESC`
    ).bind(comercioId).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioClientes, "apiFidComercioClientes");

// ---------- COBROS (panel admin) ----------

async function apiCobrosList(env) {
  try {
    const { results: comercios } = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios`).all();
    for (const c of comercios) {
      await checkAndUpdateComercioEstado(env, c.id);
    }
    const { results } = await env.DB.prepare(
      `SELECT fidelizacion_cobros.*, clients.name AS comercio_nombre, clients.whatsapp AS comercio_whatsapp,
        fidelizacion_comercios.estado AS comercio_estado,
        (SELECT COUNT(*) FROM fidelizacion_clientes WHERE fidelizacion_clientes.comercio_id = fidelizacion_comercios.id) AS clientes_actuales
       FROM fidelizacion_cobros
       JOIN fidelizacion_comercios ON fidelizacion_cobros.comercio_id = fidelizacion_comercios.id
       JOIN clients ON fidelizacion_comercios.client_id = clients.id
       WHERE fidelizacion_cobros.estado != 'pagado'
       ORDER BY fidelizacion_cobros.fecha_vencimiento ASC`
    ).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiCobrosList, "apiCobrosList");

async function apiCobroSolicitar(id, env) {
  try {
    await env.DB.prepare(
      `UPDATE fidelizacion_cobros SET estado = 'solicitado', fecha_solicitud_enviada = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiCobroSolicitar, "apiCobroSolicitar");

async function apiCobroPagado(id, env) {
  try {
    const cobro = await env.DB.prepare(`SELECT * FROM fidelizacion_cobros WHERE id = ?`).bind(id).first();
    if (!cobro) return json({ error: "Cobro no encontrado" }, 404);
    await env.DB.prepare(
      `UPDATE fidelizacion_cobros SET estado = 'pagado', fecha_pagado = datetime('now') WHERE id = ?`
    ).bind(id).run();
    await env.DB.prepare(`UPDATE fidelizacion_comercios SET estado = 'activo' WHERE id = ?`).bind(cobro.comercio_id).run();

    const proximoVencimiento = new Date(cobro.fecha_vencimiento);
    proximoVencimiento.setMonth(proximoVencimiento.getMonth() + 1);
    await env.DB.prepare(
      `INSERT INTO fidelizacion_cobros (comercio_id, periodo, monto, fecha_vencimiento, estado)
       VALUES (?, ?, ?, ?, 'pendiente')`
    ).bind(cobro.comercio_id, proximoVencimiento.toISOString().slice(0, 7), cobro.monto, proximoVencimiento.toISOString().slice(0, 10)).run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiCobroPagado, "apiCobroPagado");

// ---------- endpoints del panel del comercio (login propio) ----------

async function handleComercioApi(request, env, path, comercio) {
  const method = request.method;

  if (path === "/api/comercio/me" && method === "GET") {
    const cliente = await env.DB.prepare(`SELECT name, whatsapp FROM clients WHERE id = ?`).bind(comercio.client_id).first();
    return json({
      id: comercio.id,
      nombre: cliente ? cliente.name : "",
      niveles: comercio.niveles,
      monedas_por_nivel: comercio.monedas_por_nivel,
      validez_dias: comercio.validez_dias,
      validez_editada_por_comercio: !!comercio.validez_editada_por_comercio,
      horas_entre_sumas: (comercio.horas_entre_sumas === null || comercio.horas_entre_sumas === undefined) ? 4 : comercio.horas_entre_sumas,
      estado: comercio.estado
    });
  }

  if (path === "/api/comercio/premios" && method === "GET") {
    return apiFidPremiosGet(comercio.id, env);
  }
  if (path === "/api/comercio/premios" && method === "PATCH") {
    return apiFidPremiosPatch(comercio.id, request, env);
  }

  if (path === "/api/comercio/config" && method === "PATCH") {
    try {
      const body = await request.json();
      const fields = [];
      const values = [];
      if (body.niveles !== undefined) { fields.push("niveles = ?"); values.push(body.niveles); }
      if (body.monedas_por_nivel !== undefined) { fields.push("monedas_por_nivel = ?"); values.push(body.monedas_por_nivel); }
      if (body.horas_entre_sumas !== undefined) { fields.push("horas_entre_sumas = ?"); values.push(body.horas_entre_sumas); }
      if (body.validez_dias !== undefined) {
        if (comercio.validez_editada_por_comercio) {
          return json({ error: "Ya usaste tu cambio gratuito de la validez del cupón. Pedile a Tapy que lo actualice." }, 403);
        }
        fields.push("validez_dias = ?");
        values.push(body.validez_dias);
        fields.push("validez_editada_por_comercio = 1");
      }
      if (!fields.length) return json({ error: "Nada valido para actualizar" }, 400);
      values.push(comercio.id);
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/clientes" && method === "GET") {
    return apiFidComercioClientes(comercio.id, env);
  }

  const canjearMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/canjear$/);
  if (canjearMatch && method === "POST") {
    try {
      const clienteId = canjearMatch[1];
      const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      if (!cliente.pendiente_canje) return json({ error: "Este cliente todavia no completo el nivel" }, 409);
      const nuevoNivel = Math.min(cliente.nivel_actual + 1, comercio.niveles);
      await env.DB.prepare(
        `UPDATE fidelizacion_clientes SET nivel_actual = ?, monedas_actuales = 0, pendiente_canje = 0 WHERE id = ?`
      ).bind(nuevoNivel, clienteId).run();
      await env.DB.prepare(
        `INSERT INTO fidelizacion_canjes (fidelizacion_cliente_id, nivel_canjeado) VALUES (?, ?)`
      ).bind(clienteId, cliente.nivel_actual).run();
      return json({ ok: true, nuevo_nivel: nuevoNivel });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handleComercioApi, "handleComercioApi");

export {
  index_default as default
};
