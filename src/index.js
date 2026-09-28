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
        // Tarjetas NFC/QR impresas: este camino tiene que funcionar para siempre. No se le agrega nada.
        return await handleChipRedirect(chipMatch[1], env, ctx, request);
      }
      if (path.startsWith("/api/")) {
        const bloqueo = bloquearOrigenAjeno(request, url);
        if (bloqueo) return conCabecerasSeguridad(bloqueo, path);
        let res = await handleApi(request, env, path, ctx);
        // Afuera del panel de Tapy, un error interno nunca muestra detalles de la base de datos.
        if (res.status >= 500 && !esRutaDelDueno(path)) {
          res = json({ error: "Error interno. Probá de nuevo en un momento." }, res.status);
        }
        return conCabecerasSeguridad(res, path);
      }
      return conCabecerasSeguridad(await env.ASSETS.fetch(request), path);
    } catch (err) {
      console.error(err);
      return new Response("Error interno", { status: 500 });
    }
  }
};

// ---------- SEGURIDAD GENERAL ----------

var PAGINAS_PROPIAS = new Set([
  "/panel.html", "/panel", "/distribuidor.html", "/distribuidor", "/comercio.html", "/comercio",
  "/fidelizacion-inscripcion.html", "/fidelizacion-inscripcion", "/fidelizacion-puntos.html", "/fidelizacion-puntos"
]);
// Que puede cargar cada pagina propia: solo este dominio, las librerias de cdnjs y las fuentes de Google.
var CSP_PAGINAS = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

function conCabecerasSeguridad(res, path) {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (PAGINAS_PROPIAS.has(path)) h.set("Content-Security-Policy", CSP_PAGINAS);
  if (path.startsWith("/api/")) h.set("Cache-Control", "no-store");
  return r;
}
__name(conCabecerasSeguridad, "conCabecerasSeguridad");

// Proteccion contra pedidos falsificados desde otra pagina (CSRF): toda escritura tiene que venir
// de una pagina de este mismo dominio.
function bloquearOrigenAjeno(request, url) {
  const m = request.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  let host = null;
  try { host = new URL(origin).host; } catch (e) { host = null; }
  if (host !== url.host) return json({ error: "Pedido rechazado" }, 403);
  return null;
}
__name(bloquearOrigenAjeno, "bloquearOrigenAjeno");

function esRutaDelDueno(path) {
  return !path.startsWith("/api/public/") && !path.startsWith("/api/comercio/") && !path.startsWith("/api/distribuidor/");
}
__name(esRutaDelDueno, "esRutaDelDueno");

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (e) { return null; }
}
__name(safeDecode, "safeDecode");

// Comparacion que tarda lo mismo sin importar donde difieren (no deja adivinar de a un caracter).
function igualSeguro(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
__name(igualSeguro, "igualSeguro");

function urlSegura(u) {
  if (!u) return false;
  const txt = String(u).trim();
  if (txt.length > 2000) return false;
  try {
    const x = new URL(txt);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch (e) {
    return false;
  }
}
__name(urlSegura, "urlSegura");

// Dominios desde los que se arman links y QR. Si algun dia sumas un dominio nuevo, agregalo aca.
var DOMINIOS_PERMITIDOS = ["https://app.tapy.site", "https://tapy.enzocaballero-jv.workers.dev"];

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
      // Cada toque (o escaneo) genera un "pase de visita" nuevo, de un solo uso y que vence en
      // 10 minutos. Sin pase valido no se suma moneda: recargar, volver atras, abrir el link desde
      // el historial o reenviarselo a otra persona ya no sirve para sumar.
      let destino = `/fidelizacion-puntos.html?c=${encodeURIComponent(slug)}`;
      const viaToque = new URL(request.url).searchParams.get("src") === "qr" ? "qr" : "nfc";
      if (viaToque === "qr") destino += "&s=qr";
      try {
        destino += `&v=${await crearPaseVisita(env, slug, viaToque)}`;
      } catch (e) {
        // Si no se pudo firmar el pase, la tarjeta igual abre (solo para ver, sin sumar).
      }
      return new Response(null, {
        status: 302,
        headers: { Location: new URL(destino, request.url).toString(), "Cache-Control": "no-store" }
      });
    }

    const url = new URL(request.url);
    const source = url.searchParams.get("src") === "qr" ? "qr" : "nfc";

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
  return match ? safeDecode(match[1]) : null;
}
__name(getCookieToken, "getCookieToken");

async function handleApi(request, env, path, ctx) {
  const method = request.method;
  if (path === "/api/login" && method === "POST") {
    return apiLogin(request, env);
  }
  if (path === "/api/logout" && method === "POST") {
    return respuestaConCookie({ ok: true }, "panel_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  }
  if (path === "/api/distribuidor/logout" && method === "POST") {
    return respuestaConCookie({ ok: true }, "distribuidor_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
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
    return handlePublicFidelizacionApi(request, env, path, ctx);
  }

  // ---------- FIDELIZACION: panel del comercio, login propio ----------
  if (path === "/api/comercio/login" && method === "POST") {
    return apiComercioLogin(request, env);
  }
  if (path === "/api/comercio/logout" && method === "POST") {
    return apiComercioLogout();
  }
  if (path.startsWith("/api/comercio/")) {
    const comercio = await requireComercio(request, env);
    if (!comercio) return json({ error: "No autorizado" }, 401);
    return handleComercioApi(request, env, path, comercio);
  }

  if (!env.PANEL_PASSWORD) {
    return json({ error: "Falta configurar la variable PANEL_PASSWORD en el Worker" }, 500);
  }
  if (!(await esAdmin(request, env))) {
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
  const distPatchMatch = path.match(/^\/api\/distribuidores\/(\d+)$/);
  if (distPatchMatch && method === "PATCH") return apiDistribuidorPatch(distPatchMatch[1], request, env);
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
  const fidMetricasMatch = path.match(/^\/api\/fidelizacion\/comercios\/(\d+)\/metricas$/);
  if (fidMetricasMatch && method === "GET") return apiFidComercioMetricas(fidMetricasMatch[1], env);

  // ---------- COBROS: panel admin (Tapy) ----------
  if (path === "/api/cobros" && method === "GET") return apiCobrosList(env);
  if (path === "/api/cobros/historial" && method === "GET") return apiCobrosHistorial(env);
  const cobroSolicitarMatch = path.match(/^\/api\/cobros\/(\d+)\/solicitar$/);
  if (cobroSolicitarMatch && method === "POST") return apiCobroSolicitar(cobroSolicitarMatch[1], env);
  const cobroPagadoMatch = path.match(/^\/api\/cobros\/(\d+)\/pagado$/);
  if (cobroPagadoMatch && method === "POST") return apiCobroPagado(cobroPagadoMatch[1], env);

  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handleApi, "handleApi");

// Sesion del dueño: la cookie ya NO guarda la contraseña. Guarda un permiso firmado que vence a
// los 30 dias y que deja de valer apenas cambies PANEL_PASSWORD.
var DURACION_SESION_SEG = 30 * 24 * 3600;
async function tokenAdmin(env, exp) {
  const huella = await sha256Hex(`panel:${env.PANEL_PASSWORD || ""}`);
  return `a1.${exp}.${await signWithSecret(env, `admin|${exp}|${huella}`)}`;
}
async function esAdmin(request, env) {
  if (!env.PANEL_PASSWORD) return false;
  const t = getCookieToken(request);
  if (!t) return false;
  const partes = t.split(".");
  if (partes.length !== 3 || partes[0] !== "a1") return false;
  const exp = parseInt(partes[1], 10);
  if (!(exp > Math.floor(Date.now() / 1000))) return false;
  return igualSeguro(await tokenAdmin(env, exp), t);
}
async function apiLogin(request, env) {
  if (!env.PANEL_PASSWORD) return json({ error: "Falta configurar PANEL_PASSWORD" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body invalido" }, 400);
  }
  const claveIp = `admin:ip:${ipDe(request)}`;
  if (await superoLimite(env, claveIp, 10, 15)) {
    return json({ error: "Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo." }, 429);
  }
  if (!body.password || !igualSeguro(body.password, env.PANEL_PASSWORD)) {
    await registrarIntentoFallido(env, claveIp);
    return json({ error: "Contrasena incorrecta" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + DURACION_SESION_SEG;
  return respuestaConCookie({ ok: true }, `panel_auth=${encodeURIComponent(await tokenAdmin(env, exp))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DURACION_SESION_SEG}`);
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
    if (!urlSegura(body.destination_url) || (body.suspended_url && !urlSegura(body.suspended_url))) {
      return json({ error: "El link tiene que empezar con https:// (o http://)" }, 400);
    }
    if (!/^[a-z0-9-]{1,40}$/.test(String(body.slug))) return json({ error: "El slug solo puede tener minúsculas, números y guiones" }, 400);
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
    for (const k of ["destination_url", "suspended_url"]) {
      if (body[k] && !urlSegura(body[k])) return json({ error: "El link tiene que empezar con https:// (o http://)" }, 400);
    }
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
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key NOT IN ('secreto_sesiones', 'vapid')`).all();
    const obj = {};
    results.forEach((r) => { obj[r.key] = r.value; });
    return json(obj);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiSettingsGet, "apiSettingsGet");

// Solo se puede guardar el dominio activo, y solo uno de los dominios de Tapy.
async function apiSettingsPost(request, env) {
  try {
    const body = await request.json();
    const claves = Object.keys(body || {});
    if (!claves.length || claves.some((k) => k !== "dominio_activo")) {
      return json({ error: "Solo se puede cambiar el dominio activo" }, 400);
    }
    const dominio = String(body.dominio_activo || "").trim().replace(/\/+$/, "");
    const propio = new URL(request.url).origin;
    if (!DOMINIOS_PERMITIDOS.includes(dominio) && dominio !== propio) {
      return json({ error: "Ese dominio no es de Tapy" }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('dominio_activo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(dominio).run();
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
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 caracteres: cada byte % 32 es parejo
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
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

var MENSAJE_CHIP_FID = "Este chip es una tarjeta de fidelización. Para liberarlo, quitá el comercio desde Fidelización (así no queda a medio conectar).";
async function esChipFidelizacion(env, chipId) {
  const row = await env.DB.prepare(`SELECT tipo FROM chips WHERE id = ?`).bind(chipId).first();
  return !!(row && String(row.tipo || "").startsWith("fidelizacion"));
}

async function apiChipAsignar(chipId, request, env) {
  try {
    if (await esChipFidelizacion(env, chipId)) return json({ error: MENSAJE_CHIP_FID }, 409);
    const body = await request.json();
    if (!body.client_id || !body.destination_url) {
      return json({ error: "Faltan campos obligatorios: client_id, destination_url" }, 400);
    }
    if (!urlSegura(body.destination_url)) {
      return json({ error: "El link tiene que empezar con https:// (o http://)" }, 400);
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
    if (await esChipFidelizacion(env, chipId)) return json({ error: MENSAJE_CHIP_FID }, 409);
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
  return match ? safeDecode(match[1]) : null;
}
__name(getDistribuidorCookie, "getDistribuidorCookie");

async function tokenDistribuidor(env, dist) {
  return `d1.${dist.id}.${await signWithSecret(env, `dist|${dist.id}|${dist.password_hash}`)}`;
}
async function requireDistribuidor(request, env) {
  const token = getDistribuidorCookie(request);
  if (!token) return null;
  const partes = token.split(".");
  if (partes.length !== 3 || partes[0] !== "d1" || !/^\d+$/.test(partes[1])) return null;
  const dist = await env.DB.prepare(`SELECT * FROM distribuidores WHERE id = ?`).bind(partes[1]).first();
  if (!dist || !dist.password_hash) return null;
  if (dist.activo === 0) return null; // mayorista dado de baja
  return igualSeguro(await tokenDistribuidor(env, dist), token) ? dist : null;
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
  const usuario = String(body.usuario).trim();
  const claveUsuario = `dist:u:${usuario.toLowerCase()}`;
  const claveIp = `dist:ip:${ipDe(request)}`;
  if ((await superoLimite(env, claveUsuario, 10, 15)) || (await superoLimite(env, claveIp, 30, 15))) {
    return json({ error: "Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo." }, 429);
  }
  const dist = await env.DB.prepare(`SELECT * FROM distribuidores WHERE usuario = ?`).bind(usuario).first();
  if (!dist || !(await verificarPasswordComercio(body.password, dist.password_hash))) {
    await registrarIntentoFallido(env, claveUsuario);
    await registrarIntentoFallido(env, claveIp);
    return json({ error: "Usuario o contrasena incorrectos" }, 401);
  }
  if (dist.activo === 0) return json({ error: "Tu acceso está desactivado. Escribile a Tapy." }, 403);
  if (!String(dist.password_hash).startsWith("s1$")) {
    const nuevoHash = await hashPasswordComercio(body.password);
    await env.DB.prepare(`UPDATE distribuidores SET password_hash = ? WHERE id = ?`).bind(nuevoHash, dist.id).run();
    dist.password_hash = nuevoHash;
  }
  return respuestaConCookie({ ok: true, nombre: dist.nombre },
    `distribuidor_auth=${encodeURIComponent(await tokenDistribuidor(env, dist))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
}
__name(apiDistribuidorLogin, "apiDistribuidorLogin");

async function apiDistribuidoresList(env) {
  try {
    let results;
    try {
      ({ results } = await env.DB.prepare(`SELECT id, nombre, usuario, created_at, activo FROM distribuidores ORDER BY nombre`).all());
    } catch (e) {
      ({ results } = await env.DB.prepare(`SELECT id, nombre, usuario, created_at FROM distribuidores ORDER BY nombre`).all());
    }
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
    if (String(body.password).length < 6) return json({ error: "La contraseña tiene que tener al menos 6 caracteres" }, 400);
    const existing = await env.DB.prepare(`SELECT id FROM distribuidores WHERE usuario = ?`).bind(String(body.usuario).trim()).first();
    if (existing) return json({ error: "Ese usuario ya existe, elegi otro" }, 409);
    body.usuario = String(body.usuario).trim();
    const hash = await hashPasswordComercio(String(body.password));
    const result = await env.DB.prepare(
      `INSERT INTO distribuidores (nombre, usuario, password_hash) VALUES (?,?,?)`
    ).bind(body.nombre, body.usuario, hash).run();
    return json({ id: result.meta.last_row_id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiDistribuidoresCreate, "apiDistribuidoresCreate");

// El dueño puede cambiarle la contraseña a un mayorista o darlo de baja (y volver a darlo de alta).
async function apiDistribuidorPatch(id, request, env) {
  try {
    const body = await request.json();
    const dist = await env.DB.prepare(`SELECT id FROM distribuidores WHERE id = ?`).bind(id).first();
    if (!dist) return json({ error: "Mayorista no encontrado" }, 404);
    if (body.password !== undefined && body.password !== "") {
      if (String(body.password).length < 6) return json({ error: "La contraseña tiene que tener al menos 6 caracteres" }, 400);
      await env.DB.prepare(`UPDATE distribuidores SET password_hash = ? WHERE id = ?`).bind(await hashPasswordComercio(String(body.password)), id).run();
    }
    if (body.activo !== undefined) {
      try {
        await env.DB.prepare(`UPDATE distribuidores SET activo = ? WHERE id = ?`).bind(body.activo ? 1 : 0, id).run();
      } catch (e) {
        return json({ error: "Para dar de baja mayoristas, primero corré migracion_seguridad.sql" }, 400);
      }
    }
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiDistribuidorPatch, "apiDistribuidorPatch");

// Una empresa es "del mayorista" si la cargo el (clients.distribuidor_id). Si la columna todavia no
// existe (migracion de seguridad sin correr), se mantiene el comportamiento anterior.
async function empresaEsDelMayorista(env, clientId, distId, chipId) {
  if (chipId) {
    const chip = await env.DB.prepare(`SELECT client_id FROM chips WHERE id = ?`).bind(chipId).first();
    if (chip && Number(chip.client_id) === Number(clientId)) return true; // editar sin cambiar de empresa
  }
  let row;
  try {
    row = await env.DB.prepare(`SELECT id, distribuidor_id FROM clients WHERE id = ?`).bind(clientId).first();
  } catch (e) {
    return true;
  }
  if (!row) return false;
  return Number(row.distribuidor_id) === Number(distId);
}
__name(empresaEsDelMayorista, "empresaEsDelMayorista");

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
    // Si los chips ya tenian empresa asignada, esa empresa pasa a la cartera del mayorista
    // (asi puede seguir editandolos sin que se muevan a otra empresa).
    if (distribuidorId) {
      try {
        const marcas = chipIds.map(() => "?").join(",");
        await env.DB.prepare(
          `UPDATE clients SET distribuidor_id = ? WHERE distribuidor_id IS NULL AND name != 'STOCK - Sin Asignar'
             AND id IN (SELECT client_id FROM chips WHERE id IN (${marcas}))`
        ).bind(distribuidorId, ...chipIds).run();
      } catch (e) {} // migracion de seguridad todavia sin correr
    }
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
    let cuerpo;
    try { cuerpo = await request.clone().json(); } catch (e) { return json({ error: "Body invalido" }, 400); }
    if (!(await empresaEsDelMayorista(env, cuerpo.client_id, dist.id, chipId))) {
      return json({ error: "Esa empresa no está en tu cartera" }, 403);
    }
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
    // Solo datos de contacto de SUS empresas (nunca precios, notas ni empresas de Tapy).
    let results;
    try {
      ({ results } = await env.DB.prepare(
        `SELECT id, name, business_type, contact_name, whatsapp FROM clients WHERE distribuidor_id = ?
         UNION
         SELECT c.id, c.name, c.business_type, c.contact_name, c.whatsapp FROM clients c
           JOIN chips ch ON ch.client_id = c.id
          WHERE ch.distribuidor_id = ? AND c.name != 'STOCK - Sin Asignar'
         ORDER BY name`
      ).bind(dist.id, dist.id).all());
    } catch (e) {
      ({ results } = await env.DB.prepare(
        `SELECT DISTINCT clients.id, clients.name, clients.business_type, clients.contact_name, clients.whatsapp FROM clients
         JOIN chips ON chips.client_id = clients.id
         WHERE chips.distribuidor_id = ?`
      ).bind(dist.id).all());
    }
    return json(results);
  }
  if (path === "/api/distribuidor/clients" && method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Body invalido" }, 400); }
    const limpio = (v, max) => String(v == null ? "" : v).trim().slice(0, max) || null;
    const name = limpio(body.name, 120);
    if (!name) return json({ error: "Falta el nombre de la empresa" }, 400);
    if (name.trim().toLowerCase() === "stock - sin asignar") return json({ error: "Ese nombre está reservado" }, 400);
    const valores = [name, limpio(body.business_type, 80), limpio(body.contact_name, 120), limpio(body.whatsapp, 30), new Date().toISOString().slice(0, 10)];
    let result;
    try {
      result = await env.DB.prepare(
        `INSERT INTO clients (name, business_type, contact_name, whatsapp, signup_date, plan, billing_freq, status, distribuidor_id)
         VALUES (?,?,?,?,?, 'mayorista', 'mensual', 'activo', ?)`
      ).bind(...valores, dist.id).run();
    } catch (e) {
      result = await env.DB.prepare(
        `INSERT INTO clients (name, business_type, contact_name, whatsapp, signup_date, plan, billing_freq, status)
         VALUES (?,?,?,?,?, 'mayorista', 'mensual', 'activo')`
      ).bind(...valores).run();
    }
    return json({ id: result.meta.last_row_id });
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handleDistribuidorApi, "handleDistribuidorApi");


// ======================================================================
// FIDELIZACION — programa de puntos/niveles por comercio (v2)
// ======================================================================

var GRACIA_DIAS = 3;
var TAP_RATE_LIMIT_HOURS = 4; // valor de respaldo si el comercio todavia no tiene horas_entre_sumas cargado
var MIN_HORAS_ENTRE_SUMAS = 0.25; // piso anti-abuso: 15 minutos entre moneda y moneda
var MAX_HORAS_ENTRE_SUMAS = 168; // una semana
var MAX_ADVERTENCIAS = 2; // con la 2a advertencia la tarjeta del cliente se bloquea
var TOPE_DIARIO_DEFAULT = 1; // comercios nuevos: 1 moneda por dia (el comercio lo puede subir, ej: un bar)
var AVISO_VENCIMIENTO_DIAS = 7; // cuantos dias antes de vencer aparece en "por vencer"
var TZ_PY = "-3 hours"; // Paraguay, para que "este mes" sea el mes de Paraguay y no el de Londres
var LIMITE_FALLOS_POR_NUMERO = 5; // intentos con nombre equivocado sobre un mismo numero, cada 30 min
var LIMITE_FALLOS_POR_IP = 30; // amplio: en Paraguay muchos clientes comparten IP (datos moviles, wifi del local)
var LIMITE_LOGIN_FALLIDOS = 10; // por IP cada 15 minutos

function fechaDb(d) {
  return d.toISOString().replace("T", " ").slice(0, 19);
}
__name(fechaDb, "fechaDb");

function ipDe(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "local";
}
__name(ipDe, "ipDe");

// Limite de intentos fallidos. Si la tabla todavia no existe (migracion v3 sin correr), no bloquea nada.
async function superoLimite(env, clave, maximo, minutos) {
  try {
    const desde = fechaDb(new Date(Date.now() - minutos * 60000));
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fidelizacion_intentos WHERE clave = ? AND ts > ?`).bind(clave, desde).first();
    return !!(row && row.n >= maximo);
  } catch (e) {
    return false;
  }
}
__name(superoLimite, "superoLimite");

async function registrarIntentoFallido(env, clave) {
  try {
    await env.DB.prepare(`INSERT INTO fidelizacion_intentos (clave) VALUES (?)`).bind(clave).run();
    if (Math.random() < 0.05) {
      await env.DB.prepare(`DELETE FROM fidelizacion_intentos WHERE ts < ?`).bind(fechaDb(new Date(Date.now() - 86400000))).run();
    }
  } catch (e) {}
}
__name(registrarIntentoFallido, "registrarIntentoFallido");

var MENSAJE_DEMASIADOS_INTENTOS = { error: "demasiados_intentos", mensaje: "Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo." };

// "María José" y "maria" coinciden: se compara el primer nombre, sin tildes ni mayusculas.
function primerNombre(nombre) {
  return String(nombre || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().split(/\s+/)[0] || "";
}
__name(primerNombre, "primerNombre");

function nombreCoincide(registrado, escrito) {
  const a = primerNombre(registrado);
  const b = primerNombre(escrito);
  return !!a && a === b;
}
__name(nombreCoincide, "nombreCoincide");

function respuestaNombreNoCoincide() {
  return json({
    error: "nombre_no_coincide",
    mensaje: "Ese número ya está en el club con otro nombre. Escribí el nombre con el que te sumaste."
  }, 409);
}

// Frena a quien prueba numeros o nombres: por numero (evita adivinar el nombre de una persona)
// y por IP con un margen amplio (evita barridos de numeros sin bloquear a clientes reales).
function clavesLimite(request, comercioId, whatsapp) {
  return { num: `num:${comercioId}:${whatsapp}`, ip: `ip:${ipDe(request)}` };
}
async function bloqueadoPorIntentos(env, claves) {
  return (await superoLimite(env, claves.num, LIMITE_FALLOS_POR_NUMERO, 30))
      || (await superoLimite(env, claves.ip, LIMITE_FALLOS_POR_IP, 30));
}
async function registrarFallo(env, claves) {
  await registrarIntentoFallido(env, claves.num);
  await registrarIntentoFallido(env, claves.ip);
}
__name(respuestaNombreNoCoincide, "respuestaNombreNoCoincide");

function whatsappValido(w) {
  // Celular de Paraguay: 9 digitos empezando con 9 (0981 123 456 -> 981123456)
  return /^9\d{8}$/.test(w);
}
__name(whatsappValido, "whatsappValido");

// Todas las sesiones y links se firman con una clave secreta propia, larga y al azar, que el sistema
// genera solo la primera vez y guarda en la base. Ya NO se usa la contraseña del panel para firmar:
// asi nadie puede deducir tu contraseña a partir de una sesion.
var _secretoSesiones = null;
async function secretoSesiones(env) {
  if (_secretoSesiones) return _secretoSesiones;
  let row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'secreto_sesiones'`).first();
  if (!row || !row.value) {
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('secreto_sesiones', ?)`).bind(randomHex(32)).run();
    row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'secreto_sesiones'`).first();
  }
  _secretoSesiones = row.value;
  return _secretoSesiones;
}
__name(secretoSesiones, "secretoSesiones");

var _clavesHmac = new Map();
async function hmacHex(secreto, texto) {
  let key = _clavesHmac.get(secreto);
  if (!key) {
    key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    _clavesHmac.set(secreto, key);
  }
  const firma = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(firma)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");

async function signWithSecret(env, text) {
  return hmacHex(await secretoSesiones(env), text);
}
__name(signWithSecret, "signWithSecret");

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomHex, "randomHex");

// ---------- pase de visita: cada toque de la tarjeta vale UNA sola moneda ----------
// Dura menos que la espera minima entre monedas (15 min): asi un mismo pase nunca puede dar 2
// monedas a la misma persona. Ademas queda anotado al usarse, para que no lo use nadie mas.
var VIGENCIA_PASE_SEG = 600;
async function crearPaseVisita(env, slug, via) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomHex(6);
  const firma = (await signWithSecret(env, `visita|${slug}|${ts}|${nonce}|${via === "qr" ? "qr" : "nfc"}`)).slice(0, 24);
  return `${ts}.${nonce}.${firma}`;
}
__name(crearPaseVisita, "crearPaseVisita");

async function paseVisitaValido(env, slug, pase, via) {
  const p = String(pase || "").split(".");
  if (p.length !== 3 || !/^\d{9,11}$/.test(p[0]) || !/^[0-9a-f]{12}$/.test(p[1]) || !/^[0-9a-f]{24}$/.test(p[2])) return false;
  const edad = Math.floor(Date.now() / 1000) - Number(p[0]);
  if (edad < -60 || edad > VIGENCIA_PASE_SEG) return false;
  const esperado = (await signWithSecret(env, `visita|${slug}|${p[0]}|${p[1]}|${via === "qr" ? "qr" : "nfc"}`)).slice(0, 24);
  return igualSeguro(esperado, p[2]);
}
__name(paseVisitaValido, "paseVisitaValido");

// Anota el pase como usado por este cliente. true = recien usado; false = ya lo habia usado alguien.
async function usarPaseVisita(env, pase, clienteId) {
  try {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO fidelizacion_visitas (pase, cliente_id) VALUES (?, ?)`
    ).bind(pase, clienteId).run();
    if (Math.random() < 0.05) {
      await env.DB.prepare(`DELETE FROM fidelizacion_visitas WHERE ts < datetime('now', '-2 days')`).run().catch(() => {});
    }
    return !!(r.meta && r.meta.changes);
  } catch (e) {
    // Sin la migracion v4 todavia: igual valen la firma y los 10 minutos del pase.
    if (/no such table/i.test(String(e && e.message))) return true;
    throw e;
  }
}
__name(usarPaseVisita, "usarPaseVisita");

// Fechas de SQLite ("2026-09-27 18:04:11", en UTC) a Date de JS.
function parseFechaDb(s) {
  if (!s) return null;
  const txt = String(s);
  const iso = txt.includes("T") ? txt : txt.replace(" ", "T");
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
}
__name(parseFechaDb, "parseFechaDb");

function ahoraDb() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
__name(ahoraDb, "ahoraDb");

function horasEsperaComercio(comercio) {
  const raw = comercio.horas_entre_sumas;
  const h = raw === null || raw === undefined || raw === "" ? TAP_RATE_LIMIT_HOURS : Number(raw);
  if (!isFinite(h)) return TAP_RATE_LIMIT_HOURS;
  return Math.min(MAX_HORAS_ENTRE_SUMAS, Math.max(MIN_HORAS_ENTRE_SUMAS, h));
}
__name(horasEsperaComercio, "horasEsperaComercio");

// 0 = sin limite por dia (ej: un bar). Igual rige la espera minima entre monedas y el encargado
// controla cada moneda con los avisos.
function topeDiarioComercio(comercio) {
  const t = parseInt(comercio.tope_diario, 10);
  if (t === 0) return 0;
  return t > 0 ? t : TOPE_DIARIO_DEFAULT;
}
__name(topeDiarioComercio, "topeDiarioComercio");

// ---------- contraseñas y sesion del panel del comercio ----------

async function hashPasswordComercio(password) {
  const salt = randomHex(16);
  return `s1$${salt}$${await sha256Hex(`${salt}:${password}`)}`;
}
__name(hashPasswordComercio, "hashPasswordComercio");

async function verificarPasswordComercio(password, stored) {
  if (!stored || !password) return false;
  if (stored.startsWith("s1$")) {
    const partes = stored.split("$");
    if (partes.length !== 3) return false;
    return igualSeguro(await sha256Hex(`${partes[1]}:${password}`), partes[2]);
  }
  // formato viejo (sin sal): se actualiza solo en el proximo login
  return igualSeguro(await sha256Hex(password), stored);
}
__name(verificarPasswordComercio, "verificarPasswordComercio");

async function tokenSesionComercio(env, comercio) {
  return `${comercio.id}:${await signWithSecret(env, `comercio:${comercio.id}:${comercio.password_hash}`)}`;
}
__name(tokenSesionComercio, "tokenSesionComercio");

function cookieSesionComercio(token) {
  return `comercio_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}
__name(cookieSesionComercio, "cookieSesionComercio");

function getComercioCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/comercio_auth=([^;]+)/);
  return match ? safeDecode(match[1]) : null;
}
__name(getComercioCookie, "getComercioCookie");

async function requireComercio(request, env) {
  const token = getComercioCookie(request);
  if (!token) return null;
  const idx = token.indexOf(":");
  if (idx < 1) return null;
  const idStr = token.slice(0, idx);
  const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE id = ?`).bind(idStr).first();
  if (!comercio || !comercio.password_hash) return null;
  const esperado = await tokenSesionComercio(env, comercio);
  return igualSeguro(esperado, token) ? comercio : null;
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
  const claveUsuario = `login:u:${String(body.usuario).trim().toLowerCase()}`;
  const claveIp = `login:ip:${ipDe(request)}`;
  if ((await superoLimite(env, claveUsuario, LIMITE_LOGIN_FALLIDOS, 15)) || (await superoLimite(env, claveIp, LIMITE_LOGIN_FALLIDOS * 3, 15))) {
    return json({ error: "Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo." }, 429);
  }
  const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE usuario = ?`).bind(String(body.usuario).trim()).first();
  if (!comercio || !(await verificarPasswordComercio(body.password, comercio.password_hash))) {
    await registrarIntentoFallido(env, claveUsuario);
    await registrarIntentoFallido(env, claveIp);
    return json({ error: "Usuario o contraseña incorrectos" }, 401);
  }
  if (!String(comercio.password_hash).startsWith("s1$")) {
    const nuevoHash = await hashPasswordComercio(body.password);
    await env.DB.prepare(`UPDATE fidelizacion_comercios SET password_hash = ? WHERE id = ?`).bind(nuevoHash, comercio.id).run();
    comercio.password_hash = nuevoHash;
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", cookieSesionComercio(await tokenSesionComercio(env, comercio)));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(apiComercioLogin, "apiComercioLogin");

function apiComercioLogout() {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", "comercio_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(apiComercioLogout, "apiComercioLogout");

// ---------- sesion (cookie) del cliente final, anonima, firmada ----------

function getFidSessionCookie(request, comercioId) {
  const cookie = request.headers.get("Cookie") || "";
  const re = new RegExp(`(?:^|;\\s*)fid_${comercioId}=([^;]+)`);
  const match = cookie.match(re);
  return match ? safeDecode(match[1]) : null;
}
__name(getFidSessionCookie, "getFidSessionCookie");

async function buildFidSessionCookie(env, comercioId, clienteId) {
  const hash = await signWithSecret(env, `${comercioId}:${clienteId}`);
  return `fid_${comercioId}=${encodeURIComponent(`${clienteId}:${hash}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}
__name(buildFidSessionCookie, "buildFidSessionCookie");

async function getFidClienteIdFromCookie(request, env, comercioId) {
  const token = getFidSessionCookie(request, comercioId);
  if (!token) return null;
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [clienteIdStr, hash] = parts;
  const expected = await signWithSecret(env, `${comercioId}:${clienteIdStr}`);
  if (!igualSeguro(expected, hash)) return null;
  return clienteIdStr;
}
__name(getFidClienteIdFromCookie, "getFidClienteIdFromCookie");

// Link personal "Mi tarjeta" que el comercio manda por WhatsApp: abre la tarjeta del
// cliente directo, sin pedirle nada.
async function tokenTarjeta(env, comercioId, clienteId) {
  const sig = await signWithSecret(env, `tarjeta:${comercioId}:${clienteId}`);
  return `${clienteId}.${sig.slice(0, 24)}`;
}
__name(tokenTarjeta, "tokenTarjeta");

async function clienteIdDesdeTokenTarjeta(env, comercioId, token) {
  if (!token) return null;
  const partes = String(token).split(".");
  if (partes.length !== 2 || !/^\d+$/.test(partes[0])) return null;
  const esperado = await tokenTarjeta(env, comercioId, partes[0]);
  return igualSeguro(esperado, token) ? partes[0] : null;
}
__name(clienteIdDesdeTokenTarjeta, "clienteIdDesdeTokenTarjeta");

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
    const limite = parseFechaDb(cobro.fecha_solicitud_enviada);
    if (limite) {
      limite.setDate(limite.getDate() + GRACIA_DIAS);
      if (new Date() > limite) {
        await env.DB.prepare(`UPDATE fidelizacion_cobros SET estado = 'vencido_suspendido' WHERE id = ?`).bind(cobro.id).run();
        await env.DB.prepare(`UPDATE fidelizacion_comercios SET estado = 'suspendido' WHERE id = ?`).bind(comercioId).run();
        return "suspendido";
      }
    }
  }
  return "activo";
}
__name(checkAndUpdateComercioEstado, "checkAndUpdateComercioEstado");

// ---------- vencimiento de monedas ----------

// Si el cliente no vuelve en "validez_dias" dias, sus monedas vuelven a 0 (sigue en el club,
// el comercio no pierde su contacto). Un premio ya ganado y no retirado NO vence.
// Se aplica cada vez que alguien mira o toca algo de ese comercio: no hace falta un cron.
// El reloj del vencimiento arranca en la ultima visita, o en la fecha en que el comercio cambio
// (achico) el plazo, la que sea mas nueva: asi achicar el plazo nunca borra monedas de golpe.
function inicioVencimiento(comercio, cliente) {
  const ultima = cliente.ultimo_tap || cliente.created_at || "";
  const desde = comercio.validez_desde || "";
  return ultima > desde ? ultima : desde;
}
__name(inicioVencimiento, "inicioVencimiento");

async function aplicarVencimientos(env, comercio) {
  const dias = Number(comercio.validez_dias) || 0;
  if (dias <= 0) return;
  // Si la migracion v3 todavia no se corrio, la columna no existe: no vencemos nada (mejor no
  // borrar monedas que borrarlas de golpe). En cuanto se corre la v3, empieza a funcionar solo.
  if (comercio.validez_desde === undefined) return;
  // Un solo corte calculado una vez: las dos sentencias ven exactamente el mismo instante.
  const corte = fechaDb(new Date(Date.now() - dias * 86400000));
  const desde = comercio.validez_desde || "";
  if (desde && desde > corte) return; // el plazo se cambio hace menos de "dias": nadie puede vencer todavia
  const condicion = `comercio_id = ? AND pendiente_canje = 0 AND monedas_actuales > 0
      AND COALESCE(ultimo_tap, created_at) < ?`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen)
       SELECT id, -monedas_actuales, 'vencimiento' FROM fidelizacion_clientes WHERE ${condicion}`
    ).bind(comercio.id, corte),
    env.DB.prepare(
      `UPDATE fidelizacion_clientes SET monedas_actuales = 0, aviso_vencimiento_at = NULL WHERE ${condicion}`
    ).bind(comercio.id, corte)
  ]);
}
__name(aplicarVencimientos, "aplicarVencimientos");

function diasParaVencer(comercio, cliente) {
  const dias = Number(comercio.validez_dias) || 0;
  if (!dias || cliente.pendiente_canje || !cliente.monedas_actuales) return null;
  const base = parseFechaDb(inicioVencimiento(comercio, cliente));
  if (!base) return null;
  const vence = base.getTime() + dias * 86400000;
  return Math.max(0, Math.ceil((vence - Date.now()) / 86400000));
}
__name(diasParaVencer, "diasParaVencer");

// ---------- datos que ve el cliente final ----------

async function premiosDeComercio(env, comercioId) {
  const { results } = await env.DB.prepare(
    `SELECT nivel, descripcion FROM fidelizacion_premios WHERE comercio_id = ? ORDER BY nivel`
  ).bind(comercioId).all();
  return results || [];
}
__name(premiosDeComercio, "premiosDeComercio");

async function infoPublicaComercio(env, comercio) {
  return {
    negocio_nombre: comercio.comercio_nombre,
    activo: comercio.estado === "activo",
    niveles: comercio.niveles,
    monedas_por_nivel: comercio.monedas_por_nivel,
    validez_dias: comercio.validez_dias,
    premios: await premiosDeComercio(env, comercio.id)
  };
}
__name(infoPublicaComercio, "infoPublicaComercio");

async function estadoClienteRespuesta(env, comercio, cliente) {
  const premios = await premiosDeComercio(env, comercio.id);
  const premioActual = premios.find((p) => Number(p.nivel) === Number(cliente.nivel_actual));
  return {
    ok: true,
    nombre: cliente.nombre,
    negocio_nombre: comercio.comercio_nombre,
    nivel_actual: cliente.nivel_actual,
    monedas_actuales: cliente.monedas_actuales,
    monedas_por_nivel: comercio.monedas_por_nivel,
    niveles: comercio.niveles,
    pendiente_canje: !!cliente.pendiente_canje,
    premio_nivel_actual: premioActual && premioActual.descripcion ? premioActual.descripcion : null,
    premios,
    vueltas_completadas: cliente.vueltas_completadas || 0,
    es_ultimo_nivel: Number(cliente.nivel_actual) >= Number(comercio.niveles),
    vence_en_dias: cliente.bloqueado ? null : diasParaVencer(comercio, cliente),
    validez_dias: comercio.validez_dias,
    advertencias: Number(cliente.advertencias) || 0,
    max_advertencias: MAX_ADVERTENCIAS,
    bloqueado: !!cliente.bloqueado
  };
}
__name(estadoClienteRespuesta, "estadoClienteRespuesta");

// ---------- endpoints publicos (clientes finales, sin login) ----------

async function handlePublicFidelizacionApi(request, env, path, ctx) {
  const method = request.method;
  if (path === "/api/public/fidelizacion/info" && method === "GET") return apiPublicComercioInfo(request, env);
  if (path === "/api/public/fidelizacion/inscribir" && method === "POST") return apiPublicInscribir(request, env, ctx);
  if (path === "/api/public/fidelizacion/estado" && method === "GET") return apiPublicEstado(request, env);
  if (path === "/api/public/fidelizacion/sumar" && method === "POST") return apiPublicSumar(request, env, ctx);
  if (path === "/api/public/fidelizacion/recuperar-sesion" && method === "POST") return apiPublicRecuperarSesion(request, env, ctx);
  if (path === "/api/public/fidelizacion/ver" && method === "POST") return apiPublicVer(request, env);
  return json({ error: "Ruta no encontrada" }, 404);
}
__name(handlePublicFidelizacionApi, "handlePublicFidelizacionApi");

var TIPOS_FID = ["fidelizacion_inscripcion", "fidelizacion_puntos"];

async function findComercioByChipSlugYTipo(env, slug, tipo) {
  const tipos = Array.isArray(tipo) ? tipo : [tipo];
  const marcas = tipos.map(() => "?").join(",");
  return env.DB.prepare(
    `SELECT fidelizacion_comercios.*, clients.name AS comercio_nombre, chips.id AS chip_id, chips.tipo AS chip_tipo
     FROM chips JOIN fidelizacion_comercios
       ON (chips.tipo = 'fidelizacion_inscripcion' AND fidelizacion_comercios.nfc_inscripcion_chip_id = chips.id)
       OR (chips.tipo = 'fidelizacion_puntos' AND fidelizacion_comercios.nfc_puntos_chip_id = chips.id)
     JOIN clients ON clients.id = fidelizacion_comercios.client_id
     WHERE chips.slug = ? AND chips.tipo IN (${marcas})`
  ).bind(slug, ...tipos).first();
}
__name(findComercioByChipSlugYTipo, "findComercioByChipSlugYTipo");

var MENSAJE_SUSPENDIDO = { error: "suspendido", mensaje: "Este comercio no tiene el club de fidelidad activo en este momento." };

function respuestaConCookie(data, cookie, status = 200) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
__name(respuestaConCookie, "respuestaConCookie");

async function apiPublicComercioInfo(request, env) {
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return json({ error: "Falta el parametro slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, TIPOS_FID);
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);
    const info = await infoPublicaComercio(env, comercio);
    return json({ nombre: comercio.comercio_nombre, ...info });
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

// Suma 1 moneda. La actualizacion es condicional y atomica: si llegan 2 toques al mismo tiempo
// (doble apertura del NFC, doble clic), solo uno gana. "corteEspera" (opcional) exige que la
// ultima moneda sea anterior a ese instante; sin corte (bienvenida/manual) no hay espera.
async function acreditarMoneda(env, comercio, cliente, origen, corteEspera, via) {
  const tope = Number(comercio.monedas_por_nivel) || 1;
  const cond = corteEspera ? ` AND (ultimo_tap IS NULL OR ultimo_tap <= ?)` : "";
  const binds = [tope, tope, cliente.id, Number(cliente.monedas_actuales) || 0];
  if (corteEspera) binds.push(corteEspera);
  const r = await env.DB.prepare(
    `UPDATE fidelizacion_clientes
       SET monedas_actuales = MIN(monedas_actuales + 1, ?),
           pendiente_canje = CASE WHEN monedas_actuales + 1 >= ? THEN 1 ELSE 0 END,
           ultimo_tap = datetime('now'), aviso_vencimiento_at = NULL
     WHERE id = ? AND pendiente_canje = 0 AND bloqueado = 0 AND monedas_actuales = ?${cond}`
  ).bind(...binds).run();
  if (!r.meta || !r.meta.changes) return { acreditada: false, nivelCompleto: false };
  // Solo quien gano la actualizacion escribe su renglon de historial.
  const ins = await env.DB.prepare(
    `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen, via) VALUES (?, 1, ?, ?)`
  ).bind(cliente.id, origen, via === "qr" ? "qr" : via === "nfc" ? "nfc" : null).run();
  const tapId = ins.meta ? ins.meta.last_row_id : null;
  const nuevas = Math.min((Number(cliente.monedas_actuales) || 0) + 1, tope);
  cliente.monedas_actuales = nuevas;
  cliente.pendiente_canje = nuevas >= tope ? 1 : 0;
  cliente.ultimo_tap = ahoraDb();
  cliente.aviso_vencimiento_at = null;
  return { acreditada: true, nivelCompleto: !!cliente.pendiente_canje, tapId };
}
__name(acreditarMoneda, "acreditarMoneda");

async function intentarSumarMoneda(env, comercio, cliente, slug, pase, via) {
  // Tarjeta bloqueada por 2 advertencias: no suma nada hasta que el comercio la desbloquee.
  if (cliente.bloqueado) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)) };
  }
  if (cliente.pendiente_canje) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)), nivel_completo: true };
  }
  // Sin un toque fresco de la tarjeta del mostrador no hay moneda (ver "pase de visita").
  if (!(await paseVisitaValido(env, slug, pase, via))) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)), sin_visita: true };
  }
  const horasEspera = horasEsperaComercio(comercio);
  const respuestaEspera = async (c) => {
    const base = parseFechaDb(c.ultimo_tap);
    const limite = base ? base.getTime() + horasEspera * 3600000 : Date.now() + 60000;
    return {
      ...(await estadoClienteRespuesta(env, comercio, c)),
      ya_sumaste: true,
      minutos_para_sumar: Math.max(1, Math.ceil((limite - Date.now()) / 60000))
    };
  };
  const base = parseFechaDb(cliente.ultimo_tap);
  if (base && Date.now() < base.getTime() + horasEspera * 3600000) return respuestaEspera(cliente);

  // Tope por dia calendario de Paraguay (se reinicia a medianoche, no 24 h despues)
  const tope = topeDiarioComercio(comercio);
  const hoy = tope === 0 ? null : await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM fidelizacion_taps
     WHERE fidelizacion_cliente_id = ? AND delta > 0 AND origen IN ('tap', 'bienvenida')
       AND date(ts, '${TZ_PY}') = date('now', '${TZ_PY}')`
  ).bind(cliente.id).first();
  if (hoy && hoy.n >= tope) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)), tope_alcanzado: true, tope_diario: tope };
  }
  if (!(await usarPaseVisita(env, pase, cliente.id))) {
    return { ...(await estadoClienteRespuesta(env, comercio, cliente)), visita_usada: true };
  }
  const corte = fechaDb(new Date(Date.now() - horasEspera * 3600000));
  const r = await acreditarMoneda(env, comercio, cliente, "tap", corte, via);
  if (!r.acreditada) {
    // Otro toque simultaneo gano la carrera: mostramos el estado real, sin sumar dos veces.
    const fresco = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ?`).bind(cliente.id).first();
    if (fresco && fresco.pendiente_canje) return { ...(await estadoClienteRespuesta(env, comercio, fresco)), nivel_completo: true };
    return respuestaEspera(fresco || cliente);
  }
  return { ...(await estadoClienteRespuesta(env, comercio, cliente)), sumo_moneda: true, nivel_completo: r.nivelCompleto, tap_id: r.tapId };
}
__name(intentarSumarMoneda, "intentarSumarMoneda");

// Saca el dato interno (id del toque) de la respuesta al cliente y, si sumo moneda, le avisa al comercio.
function responderSuma(ctx, env, comercio, cliente, resultado, via) {
  const tapId = resultado.tap_id;
  delete resultado.tap_id;
  if (resultado.sumo_moneda && tapId) avisarComercio(ctx, env, comercio, cliente, tapId, "tap", via);
  return resultado;
}
__name(responderSuma, "responderSuma");

// Inscripcion: sirve desde cualquiera de las 2 tarjetas (inscripcion o puntos).
// Al inscribirse por primera vez, el cliente se lleva su moneda de bienvenida.
async function apiPublicInscribir(request, env, ctx) {
  try {
    const body = await request.json();
    const slug = body.slug;
    const nombre = String(body.nombre || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const whatsapp = normalizarWhatsapp(body.whatsapp);
    if (!slug || !nombre || !whatsapp || !body.acepta) {
      return json({ error: "Faltan datos: nombre, whatsapp y la aceptación son obligatorios" }, 400);
    }
    const comercio = await findComercioByChipSlugYTipo(env, slug, TIPOS_FID);
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") return json(MENSAJE_SUSPENDIDO, 403);

    const claves = clavesLimite(request, comercio.id, whatsapp);
    await aplicarVencimientos(env, comercio);

    const buscar = () => env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? AND whatsapp = ?`
    ).bind(comercio.id, whatsapp).first();
    let cliente = await buscar();

    let esNuevo = false;
    let nivelCompleto = false;
    if (!cliente) {
      // El formato estricto se exige solo a los nuevos: un cliente viejo con otro formato puede seguir entrando.
      if (!whatsappValido(whatsapp)) {
        return json({ error: "whatsapp_invalido", mensaje: "Revisá tu número: tiene que ser un celular de Paraguay, por ejemplo 0981 234 567." }, 400);
      }
      try {
        const result = await env.DB.prepare(
          `INSERT INTO fidelizacion_clientes (comercio_id, nombre, whatsapp) VALUES (?, ?, ?)`
        ).bind(comercio.id, nombre, whatsapp).run();
        cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ?`).bind(result.meta.last_row_id).first();
        esNuevo = true;
        // Si se inscribio tocando la tarjeta del mostrador, ese toque ya quedo usado (no se reenvia).
        const viaIns = body.via === "qr" ? "qr" : "nfc";
        const conPase = !!body.v && comercio.chip_tipo === "fidelizacion_puntos" && (await paseVisitaValido(env, slug, body.v, viaIns));
        const bienvenida = await acreditarMoneda(env, comercio, cliente, "bienvenida", null, conPase ? viaIns : null);
        nivelCompleto = bienvenida.nivelCompleto;
        if (bienvenida.tapId) avisarComercio(ctx, env, comercio, cliente, bienvenida.tapId, "bienvenida");
        if (conPase) await usarPaseVisita(env, body.v, cliente.id);
      } catch (e) {
        // Doble envio del formulario: la otra solicitud ya lo creo. Seguimos con ese cliente.
        cliente = await buscar();
        if (!cliente) throw e;
      }
    }
    // Un numero ya registrado solo entra si el nombre coincide (no se renombra ni se "roba" la cuenta).
    if (!esNuevo) {
      if (await bloqueadoPorIntentos(env, claves)) return json(MENSAJE_DEMASIADOS_INTENTOS, 429);
      if (!nombreCoincide(cliente.nombre, nombre)) {
        await registrarFallo(env, claves);
        return respuestaNombreNoCoincide();
      }
    }

    const data = {
      ...(await estadoClienteRespuesta(env, comercio, cliente)),
      bienvenida: esNuevo,
      ya_inscripto: !esNuevo,
      sumo_moneda: esNuevo,
      nivel_completo: nivelCompleto
    };
    return respuestaConCookie(data, await buildFidSessionCookie(env, comercio.id, cliente.id));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicInscribir, "apiPublicInscribir");

// "Mi tarjeta": muestra el estado SIN sumar moneda. Acepta el link personal (?t=) o la cookie.
async function apiPublicEstado(request, env) {
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return json({ error: "Falta el parametro slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, TIPOS_FID);
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") return json(MENSAJE_SUSPENDIDO, 403);

    let cookieNueva = null;
    let clienteId = await clienteIdDesdeTokenTarjeta(env, comercio.id, url.searchParams.get("t"));
    if (clienteId) {
      cookieNueva = await buildFidSessionCookie(env, comercio.id, clienteId);
    } else {
      clienteId = await getFidClienteIdFromCookie(request, env, comercio.id);
    }
    if (!clienteId) return json({ needsWhatsapp: true, ...(await infoPublicaComercio(env, comercio)) });

    await aplicarVencimientos(env, comercio);
    const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
    if (!cliente) return json({ needsWhatsapp: true, ...(await infoPublicaComercio(env, comercio)) });

    return respuestaConCookie(await estadoClienteRespuesta(env, comercio, cliente), cookieNueva);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicEstado, "apiPublicEstado");

async function apiPublicSumar(request, env, ctx) {
  try {
    const body = await request.json();
    const slug = body.slug;
    if (!slug) return json({ error: "Falta el slug" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_puntos");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") return json(MENSAJE_SUSPENDIDO, 403);

    const clienteId = await getFidClienteIdFromCookie(request, env, comercio.id);
    if (!clienteId) return json({ needsWhatsapp: true, ...(await infoPublicaComercio(env, comercio)) });
    await aplicarVencimientos(env, comercio);
    const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
    if (!cliente) return json({ needsWhatsapp: true, ...(await infoPublicaComercio(env, comercio)) });

    const via = body.via === "qr" ? "qr" : "nfc";
    const resultado = await intentarSumarMoneda(env, comercio, cliente, slug, body.v, via);
    return json(responderSuma(ctx, env, comercio, cliente, resultado, via));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicSumar, "apiPublicSumar");

// Cliente que ya es parte del club pero es su primera vez en este celular (tarjeta de puntos):
// lo reconocemos por WhatsApp y le sumamos la moneda de esta visita.
async function apiPublicRecuperarSesion(request, env, ctx) {
  try {
    const body = await request.json();
    const { slug } = body;
    const whatsapp = normalizarWhatsapp(body.whatsapp);
    if (!slug || !whatsapp || !body.nombre) return json({ error: "Faltan tu nombre y tu WhatsApp" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, "fidelizacion_puntos");
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") return json(MENSAJE_SUSPENDIDO, 403);

    const claves = clavesLimite(request, comercio.id, whatsapp);
    if (await bloqueadoPorIntentos(env, claves)) return json(MENSAJE_DEMASIADOS_INTENTOS, 429);

    await aplicarVencimientos(env, comercio);
    const cliente = await env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? AND whatsapp = ?`
    ).bind(comercio.id, whatsapp).first();
    if (!cliente) {
      await registrarFallo(env, claves);
      return json({ error: "no_encontrado", mensaje: "Todavía no sos parte del club con ese número." }, 404);
    }
    if (!nombreCoincide(cliente.nombre, body.nombre)) {
      await registrarFallo(env, claves);
      return respuestaNombreNoCoincide();
    }
    const via = body.via === "qr" ? "qr" : "nfc";
    const resultado = responderSuma(ctx, env, comercio, cliente, await intentarSumarMoneda(env, comercio, cliente, slug, body.v, via), via);
    return respuestaConCookie(resultado, await buildFidSessionCookie(env, comercio.id, cliente.id));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicRecuperarSesion, "apiPublicRecuperarSesion");

// "Ver mi tarjeta" desde otro celular: se identifica con su WhatsApp y ve su estado, sin sumar.
async function apiPublicVer(request, env) {
  try {
    const body = await request.json();
    const slug = body.slug;
    const whatsapp = normalizarWhatsapp(body.whatsapp);
    if (!slug || !whatsapp || !body.nombre) return json({ error: "Faltan tu nombre y tu WhatsApp" }, 400);
    const comercio = await findComercioByChipSlugYTipo(env, slug, TIPOS_FID);
    if (!comercio) return json({ error: "Tarjeta no reconocida" }, 404);

    const estado = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estado !== "activo") return json(MENSAJE_SUSPENDIDO, 403);

    const claves = clavesLimite(request, comercio.id, whatsapp);
    if (await bloqueadoPorIntentos(env, claves)) return json(MENSAJE_DEMASIADOS_INTENTOS, 429);

    await aplicarVencimientos(env, comercio);
    const cliente = await env.DB.prepare(
      `SELECT * FROM fidelizacion_clientes WHERE comercio_id = ? AND whatsapp = ?`
    ).bind(comercio.id, whatsapp).first();
    if (!cliente) {
      await registrarFallo(env, claves);
      return json({ error: "no_encontrado", mensaje: "Todavía no sos parte del club con ese número." }, 404);
    }
    if (!nombreCoincide(cliente.nombre, body.nombre)) {
      await registrarFallo(env, claves);
      return respuestaNombreNoCoincide();
    }
    return respuestaConCookie(await estadoClienteRespuesta(env, comercio, cliente), await buildFidSessionCookie(env, comercio.id, cliente.id));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiPublicVer, "apiPublicVer");

// ---------- AVISOS AL COMERCIO (notificaciones push al celular del encargado) ----------
// Cada vez que un cliente suma una moneda, le llega un aviso a los celulares que el comercio
// activo en su panel. Si el encargado no le cobro a nadie en ese momento, entra al aviso y le
// da una advertencia al cliente. Funciona con el estandar Web Push: sin apps ni servicios pagos.

var CONTACTO_PUSH = "https://app.tapy.site";
var MAX_CELULARES_POR_COMERCIO = 10;

function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64u, "b64u");

function deB64u(str) {
  let t = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(deB64u, "deB64u");

function unirBytes(...partes) {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
__name(unirBytes, "unirBytes");

// Par de claves propio del sistema para firmar los avisos (se genera solo, una vez, y queda en la base).
var _vapid = null;
async function clavesVapid(env) {
  if (_vapid) return _vapid;
  let row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).first();
  if (!row || !row.value) {
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privada = await crypto.subtle.exportKey("jwk", par.privateKey);
    const publica = b64u(await crypto.subtle.exportKey("raw", par.publicKey));
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)`)
      .bind(JSON.stringify({ privada, publica })).run();
    row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).first();
  }
  const datos = JSON.parse(row.value);
  const privada = await crypto.subtle.importKey("jwk", datos.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  _vapid = { privada, publica: datos.publica };
  return _vapid;
}
__name(clavesVapid, "clavesVapid");

async function cabeceraVapid(env, endpoint) {
  const { privada, publica } = await clavesVapid(env);
  const te = new TextEncoder();
  const parte = (o) => b64u(te.encode(JSON.stringify(o)));
  const sinFirma = `${parte({ typ: "JWT", alg: "ES256" })}.${parte({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: CONTACTO_PUSH
  })}`;
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privada, te.encode(sinFirma));
  return `vapid t=${sinFirma}.${b64u(firma)}, k=${publica}`;
}
__name(cabeceraVapid, "cabeceraVapid");

// Cifrado del aviso (RFC 8291, "aes128gcm"): solo el celular del comercio lo puede leer.
async function cifrarAviso(p256dh, auth, texto) {
  const te = new TextEncoder();
  const celularPublica = deB64u(p256dh);
  const secretoAuth = deB64u(auth);
  const efimera = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const servidorPublica = new Uint8Array(await crypto.subtle.exportKey("raw", efimera.publicKey));
  const claveCelular = await crypto.subtle.importKey("raw", celularPublica, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: claveCelular }, efimera.privateKey, 256));
  const hkdf = async (sal, ikm, info, largo) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sal, info }, k, largo * 8));
  };
  const ikm = await hkdf(secretoAuth, compartido, unirBytes(te.encode("WebPush: info\0"), celularPublica, servidorPublica), 32);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sal, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sal, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const claveAes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, claveAes, unirBytes(te.encode(texto), new Uint8Array([2]))));
  const cabecera = new Uint8Array(21 + servidorPublica.length);
  cabecera.set(sal, 0);
  new DataView(cabecera.buffer).setUint32(16, 4096);
  cabecera[20] = servidorPublica.length;
  cabecera.set(servidorPublica, 21);
  return unirBytes(cabecera, cifrado);
}
__name(cifrarAviso, "cifrarAviso");

// Solo se aceptan direcciones de los servicios de avisos de Google, Apple, Mozilla y Microsoft.
function endpointPushValido(u) {
  try {
    const x = new URL(String(u || ""));
    if (x.protocol !== "https:" || String(u).length > 1000) return false;
    const h = x.hostname;
    return h === "fcm.googleapis.com" || h === "android.googleapis.com" || h.endsWith(".push.apple.com") ||
      h === "updates.push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com") || h.endsWith(".notify.windows.com");
  } catch (e) {
    return false;
  }
}
__name(endpointPushValido, "endpointPushValido");

async function enviarAvisoComercio(env, comercioId, datos) {
  let subs = [];
  try {
    subs = (await env.DB.prepare(`SELECT id, endpoint, p256dh, auth FROM fidelizacion_push WHERE comercio_id = ?`).bind(comercioId).all()).results || [];
  } catch (e) {
    return { enviados: 0, total: 0, errores: ["sin_tabla"] };
  }
  const texto = JSON.stringify(datos);
  let enviados = 0;
  const errores = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          TTL: "900",
          Urgency: "high",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          Authorization: await cabeceraVapid(env, s.endpoint)
        },
        body: await cifrarAviso(s.p256dh, s.auth, texto)
      });
      if (res.ok) { enviados++; return; }
      errores.push(res.status);
      // 404/410: ese celular ya no existe o desactivo los avisos. Se borra solo.
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare(`DELETE FROM fidelizacion_push WHERE id = ?`).bind(s.id).run();
      }
    } catch (e) {
      errores.push("red");
    }
  }));
  return { enviados, total: subs.length, errores };
}
__name(enviarAvisoComercio, "enviarAvisoComercio");

function horaParaguay(ts) {
  const d = ts ? parseFechaDb(ts) : new Date();
  return new Date((d ? d.getTime() : Date.now()) - 3 * 3600000).toISOString().slice(11, 16);
}
__name(horaParaguay, "horaParaguay");

function avisarComercio(ctx, env, comercio, cliente, tapId, tipo, via) {
  const total = Number(comercio.monedas_por_nivel) || 1;
  let datos;
  if (tipo === "bienvenida") {
    datos = {
      title: `${cliente.nombre} se sumó al club`,
      body: `Moneda de bienvenida a las ${horaParaguay()} h.`,
      url: `/comercio.html?tap=${tapId}`,
      tag: `tap-${tapId}`
    };
  } else {
    const como = via === "qr" ? "Escaneó el QR" : "Tocó la tarjeta";
    const estado = cliente.pendiente_canje ? `completó el nivel ${cliente.nivel_actual}` : `lleva ${cliente.monedas_actuales} de ${total}`;
    datos = {
      title: `${cliente.nombre} sumó una moneda`,
      body: `${como} a las ${horaParaguay()} h y ${estado}. Si no estaba en el local, tocá acá para advertirle.`,
      url: `/comercio.html?tap=${tapId}`,
      tag: `tap-${tapId}`
    };
  }
  const tarea = enviarAvisoComercio(env, comercio.id, datos).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(tarea);
}
__name(avisarComercio, "avisarComercio");

// ---------- ADVERTENCIAS ----------

async function tapDelComercio(env, comercio, tapId) {
  return env.DB.prepare(
    `SELECT t.id, t.ts, t.delta, t.origen, t.anulado, t.via,
            c.id AS cliente_id, c.nombre, c.whatsapp, c.advertencias, c.bloqueado, c.monedas_actuales,
            c.pendiente_canje, c.nivel_actual,
            (SELECT COALESCE(MAX(x.id), 0) FROM fidelizacion_taps x WHERE x.fidelizacion_cliente_id = c.id AND x.origen IN ('bloqueo', 'desbloqueo')) AS corte_adv
     FROM fidelizacion_taps t JOIN fidelizacion_clientes c ON c.id = t.fidelizacion_cliente_id
     WHERE t.id = ? AND c.comercio_id = ?`
  ).bind(tapId, comercio.id).first();
}
__name(tapDelComercio, "tapDelComercio");

// Se puede advertir una moneda sumada con la tarjeta, no anulada, de un cliente no bloqueado, y
// posterior a su ultimo bloqueo/desbloqueo (lo anterior ya se sanciono o se perdono).
function tapAdvertible(t) {
  return t.origen === "tap" && t.delta > 0 && !t.anulado && !t.bloqueado && Number(t.id) > (Number(t.corte_adv) || 0);
}
__name(tapAdvertible, "tapAdvertible");

function tapParaPanel(t) {
  return {
    id: t.id, ts: t.ts, origen: t.origen, anulado: !!t.anulado, via: t.via || null,
    cliente_id: t.cliente_id, nombre: t.nombre, whatsapp: t.whatsapp,
    advertencias: Number(t.advertencias) || 0, bloqueado: !!t.bloqueado,
    monedas_actuales: t.monedas_actuales, pendiente_canje: !!t.pendiente_canje, nivel_actual: t.nivel_actual,
    se_puede_advertir: tapAdvertible(t)
  };
}
__name(tapParaPanel, "tapParaPanel");

async function advertirPorTap(env, comercio, tapId) {
  const t = await tapDelComercio(env, comercio, tapId);
  if (!t) return { status: 404, error: "No encontramos esa moneda" };
  if (t.origen !== "tap" || !(t.delta > 0)) return { status: 409, error: "Solo se puede advertir una moneda sumada con la tarjeta del mostrador" };
  if (t.bloqueado) return { status: 409, error: "La tarjeta de este cliente ya está bloqueada" };
  if (t.anulado) return { status: 409, error: "Esta moneda ya fue advertida" };
  if (!tapAdvertible(t)) return { status: 409, error: "Esta moneda es anterior a un bloqueo o desbloqueo: ya no se puede advertir" };
  // 1) Se anula la moneda, solo si seguia sin anular y el cliente no esta bloqueado. Si se toca
  //    "Advertir" dos veces (o desde dos celulares), la segunda no hace nada.
  const marca = await env.DB.prepare(
    `UPDATE fidelizacion_taps SET anulado = 1
     WHERE id = ? AND anulado = 0 AND EXISTS (SELECT 1 FROM fidelizacion_clientes WHERE id = ? AND bloqueado = 0)`
  ).bind(t.id, t.cliente_id).run();
  if (!marca.meta || !marca.meta.changes) return { status: 409, error: "Esta moneda ya fue advertida" };
  // 2) Se suma la advertencia (+1 atomico: dos advertencias al mismo tiempo cuentan como dos).
  //    Si esto fallara, la moneda vuelve a quedar como estaba, para no anularla sin advertencia.
  try {
    await env.DB.prepare(`UPDATE fidelizacion_clientes SET advertencias = advertencias + 1 WHERE id = ?`).bind(t.cliente_id).run();
  } catch (e) {
    await env.DB.prepare(`UPDATE fidelizacion_taps SET anulado = 0 WHERE id = ?`).bind(t.id).run().catch(() => {});
    throw e;
  }
  const cliente = await env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ?`).bind(t.cliente_id).first();
  const advertencias = Number(cliente.advertencias) || 0;

  if (advertencias >= MAX_ADVERTENCIAS) {
    // 2a advertencia: tarjeta bloqueada, pierde sus monedas y queda en la lista de bloqueados.
    const perdidas = Number(cliente.monedas_actuales) || 0;
    const bloqueo = await env.DB.prepare(
      `UPDATE fidelizacion_clientes SET bloqueado = 1, bloqueado_at = datetime('now'),
         monedas_actuales = 0, pendiente_canje = 0 WHERE id = ? AND bloqueado = 0`
    ).bind(cliente.id).run();
    if (bloqueo.meta && bloqueo.meta.changes) await env.DB.prepare(
      `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen) VALUES (?, ?, 'bloqueo')`
    ).bind(cliente.id, -perdidas).run();
    return { status: 200, ok: true, advertencias, bloqueado: true, moneda_anulada: perdidas > 0, monedas_actuales: 0, cliente_id: cliente.id, nombre: cliente.nombre, whatsapp: cliente.whatsapp };
  }

  // 1a advertencia: se le saca esa moneda, salvo que despues ya haya retirado un premio o se le
  // hayan vencido las monedas (en ese caso la moneda ya no esta; queda solo la advertencia).
  const despues = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM fidelizacion_canjes WHERE fidelizacion_cliente_id = ? AND ts >= ?)
          + (SELECT COUNT(*) FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ? AND id > ? AND origen IN ('vencimiento', 'bloqueo')) AS n`
  ).bind(cliente.id, t.ts, cliente.id, t.id).first();
  const quitar = !(despues && despues.n > 0) && (Number(cliente.monedas_actuales) || 0) > 0;
  await env.DB.prepare(
    `UPDATE fidelizacion_clientes SET
       monedas_actuales = CASE WHEN ? THEN MAX(monedas_actuales - 1, 0) ELSE monedas_actuales END,
       pendiente_canje = CASE WHEN ? THEN 0 ELSE pendiente_canje END
     WHERE id = ?`
  ).bind(quitar ? 1 : 0, quitar ? 1 : 0, cliente.id).run();
  await env.DB.prepare(
    `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen) VALUES (?, ?, 'advertencia')`
  ).bind(cliente.id, quitar ? -1 : 0).run();
  const monedas = quitar ? Math.max(0, (Number(cliente.monedas_actuales) || 0) - 1) : Number(cliente.monedas_actuales) || 0;
  return { status: 200, ok: true, advertencias, bloqueado: false, moneda_anulada: quitar, monedas_actuales: monedas, cliente_id: cliente.id, nombre: cliente.nombre, whatsapp: cliente.whatsapp };
}
__name(advertirPorTap, "advertirPorTap");

// ---------- consultas compartidas (panel del comercio y panel de Tapy) ----------

async function listarClientesComercio(env, comercio, conLinkTarjeta) {
  await aplicarVencimientos(env, comercio);
  const { results } = await env.DB.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM fidelizacion_taps t WHERE t.fidelizacion_cliente_id = c.id AND t.delta > 0 AND t.anulado = 0) AS visitas,
       (SELECT COUNT(*) FROM fidelizacion_canjes k WHERE k.fidelizacion_cliente_id = c.id) AS premios_canjeados
     FROM fidelizacion_clientes c
     WHERE c.comercio_id = ?
     ORDER BY c.bloqueado ASC, c.pendiente_canje DESC, c.monedas_actuales DESC, c.id DESC`
  ).bind(comercio.id).all();
  const lista = results || [];
  for (const c of lista) {
    c.vence_en_dias = diasParaVencer(comercio, c);
    if (conLinkTarjeta) c.token_tarjeta = await tokenTarjeta(env, comercio.id, c.id);
  }
  return lista;
}
__name(listarClientesComercio, "listarClientesComercio");

async function metricasComercio(env, comercio) {
  await aplicarVencimientos(env, comercio);
  const id = comercio.id;
  const mesActual = `strftime('%Y-%m', 'now', '${TZ_PY}')`;
  const mesAnterior = `strftime('%Y-%m', 'now', '${TZ_PY}', 'start of month', '-1 month')`;
  const joinTaps = `FROM fidelizacion_taps t JOIN fidelizacion_clientes c ON c.id = t.fidelizacion_cliente_id WHERE c.comercio_id = ?`;
  const joinCanjes = `FROM fidelizacion_canjes k JOIN fidelizacion_clientes c ON c.id = k.fidelizacion_cliente_id WHERE c.comercio_id = ?`;
  const dias = Number(comercio.validez_dias) || 0;
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const res = await env.DB.batch([
    q(`SELECT COUNT(*) AS n ${joinTaps} AND t.delta > 0 AND t.anulado = 0 AND strftime('%Y-%m', t.ts, '${TZ_PY}') = ${mesActual}`, id),
    q(`SELECT COUNT(*) AS n ${joinTaps} AND t.delta > 0 AND t.anulado = 0 AND strftime('%Y-%m', t.ts, '${TZ_PY}') = ${mesAnterior}`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ? AND strftime('%Y-%m', created_at, '${TZ_PY}') = ${mesActual}`, id),
    q(`SELECT COUNT(*) AS n ${joinCanjes} AND strftime('%Y-%m', k.ts, '${TZ_PY}') = ${mesActual}`, id),
    q(`SELECT COUNT(*) AS n ${joinCanjes}`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ?`, id),
    q(`SELECT COUNT(*) AS n FROM (SELECT t.fidelizacion_cliente_id ${joinTaps} AND t.delta > 0 AND t.anulado = 0 GROUP BY t.fidelizacion_cliente_id HAVING COUNT(*) >= 2)`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ? AND ultimo_tap IS NOT NULL AND julianday('now') - julianday(ultimo_tap) <= 30`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ? AND pendiente_canje = 1`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ? AND pendiente_canje = 0 AND monedas_actuales > 0 AND ? > 0
         AND MAX(COALESCE(ultimo_tap, created_at), ?) < ?`, id, dias, comercio.validez_desde || "",
      fechaDb(new Date(Date.now() - Math.max(0, dias - AVISO_VENCIMIENTO_DIAS) * 86400000))),
    q(`SELECT COALESCE(SUM(-t.delta), 0) AS n ${joinTaps} AND t.origen = 'vencimiento' AND strftime('%Y-%m', t.ts, '${TZ_PY}') = ${mesActual}`, id),
    q(`SELECT COUNT(*) AS n ${joinTaps} AND t.origen IN ('advertencia', 'bloqueo') AND strftime('%Y-%m', t.ts, '${TZ_PY}') = ${mesActual}`, id),
    q(`SELECT COUNT(*) AS n FROM fidelizacion_clientes WHERE comercio_id = ? AND bloqueado = 1`, id)
  ]);
  const n = (i) => (res[i] && res[i].results && res[i].results[0] ? Number(res[i].results[0].n) || 0 : 0);
  const clientesTotal = n(5);
  const recurrentes = n(6);
  return {
    visitas_mes: n(0),
    visitas_mes_anterior: n(1),
    nuevos_mes: n(2),
    premios_mes: n(3),
    premios_total: n(4),
    clientes_total: clientesTotal,
    clientes_recurrentes: recurrentes,
    tasa_retorno: clientesTotal ? Math.round((recurrentes / clientesTotal) * 100) : 0,
    activos_30: n(7),
    esperando_premio: n(8),
    por_vencer: n(9),
    monedas_vencidas_mes: n(10),
    advertencias_mes: n(11),
    bloqueados: n(12)
  };
}
__name(metricasComercio, "metricasComercio");

// Despues de cambiar la configuracion: nadie queda en un nivel que ya no existe, y quien ya tiene
// las monedas que ahora alcanzan para el nivel pasa a "esperando premio" al instante.
// Si se achico el vencimiento, el reloj arranca de nuevo desde hoy (nadie pierde monedas de golpe).
async function normalizarTrasConfig(env, comercioId, campos, validezAnterior) {
  if (campos.niveles) {
    await env.DB.prepare(
      `UPDATE fidelizacion_clientes SET nivel_actual = ? WHERE comercio_id = ? AND nivel_actual > ?`
    ).bind(campos.niveles, comercioId, campos.niveles).run();
  }
  if (campos.monedas_por_nivel) {
    await env.DB.prepare(
      `UPDATE fidelizacion_clientes SET monedas_actuales = ?, pendiente_canje = 1
       WHERE comercio_id = ? AND pendiente_canje = 0 AND monedas_actuales >= ?`
    ).bind(campos.monedas_por_nivel, comercioId, campos.monedas_por_nivel).run();
  }
  if (campos.validez_dias && Number(validezAnterior) && campos.validez_dias < Number(validezAnterior)) {
    try {
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET validez_desde = datetime('now') WHERE id = ?`).bind(comercioId).run();
    } catch (e) {} // columna de la migracion v3 todavia no creada
  }
}
__name(normalizarTrasConfig, "normalizarTrasConfig");

function validarConfigNumerica(body) {
  // Devuelve { campos: {col: valor}, error }
  const campos = {};
  if (body.niveles !== undefined) {
    const v = parseInt(body.niveles, 10);
    if (!(v >= 1 && v <= 20)) return { error: "Los niveles tienen que ser entre 1 y 20" };
    campos.niveles = v;
  }
  if (body.monedas_por_nivel !== undefined) {
    const v = parseInt(body.monedas_por_nivel, 10);
    if (!(v >= 1 && v <= 100)) return { error: "Las monedas por nivel tienen que ser entre 1 y 100" };
    campos.monedas_por_nivel = v;
  }
  if (body.horas_entre_sumas !== undefined) {
    const v = parseFloat(body.horas_entre_sumas);
    if (!isFinite(v)) return { error: "Espera entre sumas inválida" };
    campos.horas_entre_sumas = Math.min(MAX_HORAS_ENTRE_SUMAS, Math.max(MIN_HORAS_ENTRE_SUMAS, v));
  }
  if (body.tope_diario !== undefined) {
    const v = parseInt(body.tope_diario, 10);
    if (!(v === 0 || (v >= 1 && v <= 20))) return { error: "El máximo por día tiene que ser entre 1 y 20, o sin límite" };
    campos.tope_diario = v;
  }
  if (body.validez_dias !== undefined) {
    const v = parseInt(body.validez_dias, 10);
    if (!(v >= 14 && v <= 3650)) return { error: "El vencimiento tiene que ser de al menos 14 días" };
    campos.validez_dias = v;
  }
  return { campos };
}
__name(validarConfigNumerica, "validarConfigNumerica");

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

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM fidelizacion_taps WHERE fidelizacion_cliente_id IN (SELECT id FROM fidelizacion_clientes WHERE comercio_id = ?)`).bind(comercioId),
    env.DB.prepare(`DELETE FROM fidelizacion_canjes WHERE fidelizacion_cliente_id IN (SELECT id FROM fidelizacion_clientes WHERE comercio_id = ?)`).bind(comercioId),
    env.DB.prepare(`DELETE FROM fidelizacion_clientes WHERE comercio_id = ?`).bind(comercioId),
    env.DB.prepare(`DELETE FROM fidelizacion_premios WHERE comercio_id = ?`).bind(comercioId),
    env.DB.prepare(`DELETE FROM fidelizacion_cobros WHERE comercio_id = ?`).bind(comercioId)
  ]);
  await env.DB.prepare(`DELETE FROM fidelizacion_push WHERE comercio_id = ?`).bind(comercioId).run().catch(() => {});

  await env.DB.prepare(`DELETE FROM fidelizacion_comercios WHERE id = ?`).bind(comercioId).run();

  if (liberarChips) {
    const chipIds = [comercio.nfc_inscripcion_chip_id, comercio.nfc_puntos_chip_id].filter(Boolean);
    for (const chipId of chipIds) await devolverChipFidelizacion(env, chipId);
  }
}

// Un chip impreso (tiene numero de lote) vuelve a tu stock libre; uno virtual se borra
// (no existe fisicamente, no tiene sentido que aparezca como stock).
async function devolverChipFidelizacion(env, chipId) {
  const chip = await env.DB.prepare(`SELECT id, numero_lote, lote_id, label FROM chips WHERE id = ?`).bind(chipId).first();
  if (!chip) return;
  if (chip.numero_lote === null && chip.lote_id === null && chip.label === null) {
    await env.DB.prepare(`DELETE FROM taps WHERE chip_id = ?`).bind(chipId).run();
    await env.DB.prepare(`DELETE FROM chips WHERE id = ?`).bind(chipId).run();
    return;
  }
  const stockClientId = await getStockClientId(env);
  await env.DB.prepare(
    `UPDATE chips SET client_id = ?, destination_url = ?, status = 'sin_asignar', tipo = 'resena', label = NULL WHERE id = ?`
  ).bind(stockClientId, "https://tapy.com.py/pendiente-asignacion", chipId).run();
}
__name(devolverChipFidelizacion, "devolverChipFidelizacion");

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
      `SELECT id, slug, numero_lote FROM chips
       WHERE status = 'sin_asignar' AND distribuidor_id IS NULL AND (tipo IS NULL OR tipo = 'resena')
       ORDER BY numero_lote ASC, id ASC`
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
  const chip = await env.DB.prepare(`SELECT id, slug, status, numero_lote FROM chips WHERE id = ?`).bind(chipId).first();
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
        chip_p.numero_lote AS numero_puntos,
        (SELECT COUNT(*) FROM fidelizacion_clientes WHERE fidelizacion_clientes.comercio_id = fidelizacion_comercios.id) AS clientes_total,
        (SELECT COUNT(*) FROM fidelizacion_clientes WHERE fidelizacion_clientes.comercio_id = fidelizacion_comercios.id AND pendiente_canje = 1) AS pendientes_canje
       FROM fidelizacion_comercios
       JOIN clients ON fidelizacion_comercios.client_id = clients.id
       LEFT JOIN chips chip_i ON chip_i.id = fidelizacion_comercios.nfc_inscripcion_chip_id
       LEFT JOIN chips chip_p ON chip_p.id = fidelizacion_comercios.nfc_puntos_chip_id
       ORDER BY clients.name`
    ).all();
    for (const r of results || []) delete r.password_hash;
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
    const usuario = String(body.usuario || "").trim();
    if (!usuario || !body.password) return json({ error: "Falta usuario y contraseña para el panel del comercio" }, 400);
    if (String(body.password).length < 6) return json({ error: "La contraseña del comercio tiene que tener al menos 6 caracteres" }, 400);
    const existingUser = await env.DB.prepare(`SELECT id FROM fidelizacion_comercios WHERE usuario = ?`).bind(usuario).first();
    if (existingUser) return json({ error: "Ese usuario ya existe, elegi otro" }, 409);

    // Validamos TODO (incluidas las 2 tarjetas) antes de escribir nada en la base: si algo
    // de esto falla, no queremos dejar un comercio a medio crear que despues bloquee un
    // segundo intento (usuario/empresa ya "ocupados" por una fila fantasma).
    // Una sola tarjeta fisica por comercio: la del mostrador (inscribe a los nuevos y suma la
    // moneda a los que ya son del club). El link para redes/afiches se genera solo, sin chip.
    let chipPunValidado;
    try {
      chipPunValidado = await validarChipFidelizacion(env, body.chip_id || body.chip_puntos_id);
    } catch (err) {
      return json({ error: err.message }, 409);
    }

    const conDefaults = {
      niveles: body.niveles ?? 5,
      monedas_por_nivel: body.monedas_por_nivel ?? 10,
      horas_entre_sumas: body.horas_entre_sumas === undefined || body.horas_entre_sumas === null || body.horas_entre_sumas === "" ? 4 : body.horas_entre_sumas,
      tope_diario: body.tope_diario ?? TOPE_DIARIO_DEFAULT,
      validez_dias: body.validez_dias ?? 90
    };
    const { campos, error } = validarConfigNumerica(conDefaults);
    if (error) return json({ error }, 400);
    const passwordHash = await hashPasswordComercio(String(body.password));

    const result = await env.DB.prepare(
      `INSERT INTO fidelizacion_comercios (client_id, usuario, password_hash, niveles, monedas_por_nivel, validez_dias, horas_entre_sumas, tope_diario)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(body.client_id, usuario, passwordHash, campos.niveles, campos.monedas_por_nivel, campos.validez_dias, campos.horas_entre_sumas, campos.tope_diario).run();
    const comercioId = result.meta.last_row_id;

    const premios = Array.isArray(body.premios) ? body.premios : [];
    if (premios.length) {
      const statements = premios.map((p) =>
        env.DB.prepare(`INSERT INTO fidelizacion_premios (comercio_id, nivel, descripcion) VALUES (?,?,?)`)
          .bind(comercioId, p.nivel, p.descripcion)
      );
      await env.DB.batch(statements);
    }

    // UNA sola tarjeta: inscribe, da la moneda de bienvenida y suma puntos. Es un chip impreso
    // (NFC+QR) del stock libre, o uno virtual si no se elige ninguno.
    const chipPun = await reclamarChipFidelizacion(env, body.client_id, chipPunValidado, "fidelizacion_puntos", "Fidelizacion");

    await env.DB.prepare(
      `UPDATE fidelizacion_comercios SET nfc_inscripcion_chip_id = NULL, nfc_puntos_chip_id = ? WHERE id = ?`
    ).bind(chipPun.id, comercioId).run();

    const fechaVencimiento = new Date();
    fechaVencimiento.setMonth(fechaVencimiento.getMonth() + 2);
    await env.DB.prepare(
      `INSERT INTO fidelizacion_cobros (comercio_id, periodo, monto, fecha_vencimiento, estado)
       VALUES (?, ?, ?, ?, 'pendiente')`
    ).bind(comercioId, fechaVencimiento.toISOString().slice(0, 7), body.monto_mensual || null, fechaVencimiento.toISOString().slice(0, 10)).run();

    return json({ id: comercioId, slug_puntos: chipPun.slug, numero_lote: chipPunValidado ? chipPunValidado.numero_lote : null });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioCreate, "apiFidComercioCreate");

async function apiFidComercioPatch(id, request, env) {
  try {
    const body = await request.json();
    const { campos, error } = validarConfigNumerica(body);
    if (error) return json({ error }, 400);
    const fields = Object.keys(campos).map((k) => `${k} = ?`);
    const values = Object.keys(campos).map((k) => campos[k]);
    if (body.resetear_bloqueo_validez) fields.push("validez_editada_por_comercio = 0");
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      if (String(body.password).length < 6) return json({ error: "La contraseña nueva tiene que tener al menos 6 caracteres" }, 400);
      fields.push("password_hash = ?");
      values.push(await hashPasswordComercio(String(body.password)));
    }
    if (body.monto_mensual !== undefined) {
      await env.DB.prepare(
        `UPDATE fidelizacion_cobros SET monto = ? WHERE comercio_id = ? AND estado = 'pendiente'`
      ).bind(body.monto_mensual, id).run();
    }
    const anterior = await env.DB.prepare(`SELECT validez_dias FROM fidelizacion_comercios WHERE id = ?`).bind(id).first();
    if (fields.length) {
      values.push(id);
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    }
    await normalizarTrasConfig(env, id, campos, anterior ? anterior.validez_dias : null);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioPatch, "apiFidComercioPatch");

async function apiFidPremiosGet(comercioId, env) {
  try {
    return json(await premiosDeComercio(env, comercioId));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidPremiosGet, "apiFidPremiosGet");

async function apiFidPremiosPatch(comercioId, request, env) {
  try {
    const body = await request.json();
    const premios = Array.isArray(body.premios) ? body.premios : [];
    const statements = premios
      .filter((p) => parseInt(p.nivel, 10) >= 1)
      .map((p) =>
        env.DB.prepare(
          `INSERT INTO fidelizacion_premios (comercio_id, nivel, descripcion) VALUES (?,?,?)
           ON CONFLICT(comercio_id, nivel) DO UPDATE SET descripcion = excluded.descripcion`
        ).bind(comercioId, parseInt(p.nivel, 10), String(p.descripcion || "").trim().slice(0, 120))
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
    const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE id = ?`).bind(comercioId).first();
    if (!comercio) return json({ error: "Comercio no encontrado" }, 404);
    return json(await listarClientesComercio(env, comercio, false));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioClientes, "apiFidComercioClientes");

async function apiFidComercioMetricas(comercioId, env) {
  try {
    const comercio = await env.DB.prepare(`SELECT * FROM fidelizacion_comercios WHERE id = ?`).bind(comercioId).first();
    if (!comercio) return json({ error: "Comercio no encontrado" }, 404);
    return json(await metricasComercio(env, comercio));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiFidComercioMetricas, "apiFidComercioMetricas");

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

async function apiCobrosHistorial(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT fidelizacion_cobros.*, clients.name AS comercio_nombre
       FROM fidelizacion_cobros
       JOIN fidelizacion_comercios ON fidelizacion_cobros.comercio_id = fidelizacion_comercios.id
       JOIN clients ON fidelizacion_comercios.client_id = clients.id
       WHERE fidelizacion_cobros.estado = 'pagado'
       ORDER BY fidelizacion_cobros.fecha_pagado DESC
       LIMIT 300`
    ).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
__name(apiCobrosHistorial, "apiCobrosHistorial");

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
    if (cobro.estado === "pagado") return json({ error: "Ese cobro ya estaba marcado como pagado" }, 409);
    await env.DB.prepare(
      `UPDATE fidelizacion_cobros SET estado = 'pagado', fecha_pagado = datetime('now') WHERE id = ?`
    ).bind(id).run();
    await env.DB.prepare(`UPDATE fidelizacion_comercios SET estado = 'activo' WHERE id = ?`).bind(cobro.comercio_id).run();

    const proximoVencimiento = new Date(cobro.fecha_vencimiento + "T12:00:00Z");
    proximoVencimiento.setUTCMonth(proximoVencimiento.getUTCMonth() + 1);
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

async function dominioActivo(env) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'dominio_activo'`).first();
    return row && row.value ? String(row.value).replace(/\/$/, "") : null;
  } catch (e) {
    return null;
  }
}
__name(dominioActivo, "dominioActivo");

async function clienteDelComercio(env, comercio, clienteId) {
  return env.DB.prepare(`SELECT * FROM fidelizacion_clientes WHERE id = ? AND comercio_id = ?`).bind(clienteId, comercio.id).first();
}
__name(clienteDelComercio, "clienteDelComercio");

async function handleComercioApi(request, env, path, comercio) {
  const method = request.method;

  // Comercio suspendido por falta de pago: solo puede ver su estado y cambiar su contraseña.
  if (path !== "/api/comercio/me" && path !== "/api/comercio/password") {
    const estadoActual = await checkAndUpdateComercioEstado(env, comercio.id);
    if (estadoActual === "suspendido") {
      return json({ error: "Tu club está suspendido por falta de pago. Escribile a Tapy para reactivarlo.", suspendido: true }, 403);
    }
  }

  if (path === "/api/comercio/me" && method === "GET") {
    const cliente = await env.DB.prepare(`SELECT name, whatsapp FROM clients WHERE id = ?`).bind(comercio.client_id).first();
    const chipIns = comercio.nfc_inscripcion_chip_id
      ? await env.DB.prepare(`SELECT slug FROM chips WHERE id = ?`).bind(comercio.nfc_inscripcion_chip_id).first() : null;
    const chipPun = comercio.nfc_puntos_chip_id
      ? await env.DB.prepare(`SELECT slug FROM chips WHERE id = ?`).bind(comercio.nfc_puntos_chip_id).first() : null;
    return json({
      id: comercio.id,
      usuario: comercio.usuario,
      nombre: cliente ? cliente.name : "",
      niveles: comercio.niveles,
      monedas_por_nivel: comercio.monedas_por_nivel,
      validez_dias: comercio.validez_dias,
      validez_editada_por_comercio: !!comercio.validez_editada_por_comercio,
      horas_entre_sumas: horasEsperaComercio(comercio),
      tope_diario: topeDiarioComercio(comercio),
      estado: (await checkAndUpdateComercioEstado(env, comercio.id)) || comercio.estado,
      slug_inscripcion: chipIns ? chipIns.slug : (chipPun ? chipPun.slug : null),
      slug_puntos: chipPun ? chipPun.slug : null,
      dominio: await dominioActivo(env)
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
      const permitido = {};
      for (const k of ["niveles", "monedas_por_nivel", "horas_entre_sumas", "tope_diario"]) {
        if (body[k] !== undefined) permitido[k] = body[k];
      }
      const cambiaValidez = body.validez_dias !== undefined && Number(body.validez_dias) !== Number(comercio.validez_dias);
      if (cambiaValidez) {
        if (comercio.validez_editada_por_comercio) {
          return json({ error: "Ya usaste tu cambio gratuito del vencimiento. Pedile a Tapy que lo actualice." }, 403);
        }
        permitido.validez_dias = body.validez_dias;
      }
      const { campos, error } = validarConfigNumerica(permitido);
      if (error) return json({ error }, 400);
      const fields = Object.keys(campos).map((k) => `${k} = ?`);
      const values = Object.keys(campos).map((k) => campos[k]);
      if (cambiaValidez) fields.push("validez_editada_por_comercio = 1");
      if (!fields.length) return json({ ok: true });
      values.push(comercio.id);
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
      await normalizarTrasConfig(env, comercio.id, campos, comercio.validez_dias);
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/password" && method === "POST") {
    try {
      const body = await request.json();
      if (!(await verificarPasswordComercio(body.actual, comercio.password_hash))) {
        return json({ error: "La contraseña actual no es correcta" }, 400);
      }
      const nueva = String(body.nueva || "");
      if (nueva.length < 6) return json({ error: "La contraseña nueva tiene que tener al menos 6 caracteres" }, 400);
      const nuevoHash = await hashPasswordComercio(nueva);
      await env.DB.prepare(`UPDATE fidelizacion_comercios SET password_hash = ? WHERE id = ?`).bind(nuevoHash, comercio.id).run();
      comercio.password_hash = nuevoHash;
      return respuestaConCookie({ ok: true }, cookieSesionComercio(await tokenSesionComercio(env, comercio)));
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/metricas" && method === "GET") {
    try {
      return json(await metricasComercio(env, comercio));
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/clientes" && method === "GET") {
    try {
      return json(await listarClientesComercio(env, comercio, true));
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---------- actividad en vivo, advertencias y avisos al celular ----------
  if (path === "/api/comercio/actividad" && method === "GET") {
    try {
      const desde = parseInt(new URL(request.url).searchParams.get("desde") || "0", 10) || 0;
      const { results } = await env.DB.prepare(
        `SELECT t.id, t.ts, t.delta, t.origen, t.anulado, t.via,
                c.id AS cliente_id, c.nombre, c.whatsapp, c.advertencias, c.bloqueado, c.monedas_actuales,
                c.pendiente_canje, c.nivel_actual,
                (SELECT COALESCE(MAX(x.id), 0) FROM fidelizacion_taps x WHERE x.fidelizacion_cliente_id = c.id AND x.origen IN ('bloqueo', 'desbloqueo')) AS corte_adv
         FROM fidelizacion_taps t JOIN fidelizacion_clientes c ON c.id = t.fidelizacion_cliente_id
         WHERE c.comercio_id = ? AND t.id > ? AND t.delta > 0 AND t.origen IN ('tap', 'bienvenida')
           AND date(t.ts, '${TZ_PY}') = date('now', '${TZ_PY}')
         ORDER BY t.id DESC LIMIT 60`
      ).bind(comercio.id, desde).all();
      return json({ actividad: (results || []).map(tapParaPanel) });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const tapMatch = path.match(/^\/api\/comercio\/taps\/(\d+)$/);
  if (tapMatch && method === "GET") {
    try {
      const t = await tapDelComercio(env, comercio, tapMatch[1]);
      if (!t) return json({ error: "No encontramos esa moneda" }, 404);
      return json(tapParaPanel(t));
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const advertirMatch = path.match(/^\/api\/comercio\/taps\/(\d+)\/advertir$/);
  if (advertirMatch && method === "POST") {
    try {
      const r = await advertirPorTap(env, comercio, advertirMatch[1]);
      const { status, ...resto } = r;
      return json(resto, status);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const desbloquearMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/desbloquear$/);
  if (desbloquearMatch && method === "POST") {
    try {
      const cliente = await clienteDelComercio(env, comercio, desbloquearMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      if (!cliente.bloqueado) return json({ error: "Este cliente no está bloqueado" }, 409);
      await env.DB.prepare(
        `UPDATE fidelizacion_clientes SET bloqueado = 0, advertencias = 0, bloqueado_at = NULL WHERE id = ?`
      ).bind(cliente.id).run();
      await env.DB.prepare(
        `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen) VALUES (?, 0, 'desbloqueo')`
      ).bind(cliente.id).run();
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/push/clave" && method === "GET") {
    try {
      return json({ publica: (await clavesVapid(env)).publica });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/push/suscribir" && method === "POST") {
    try {
      const body = await request.json();
      const endpoint = String(body.endpoint || "");
      const keys = body.keys || {};
      const p256dh = String(keys.p256dh || "");
      const auth = String(keys.auth || "");
      if (!endpointPushValido(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
        return json({ error: "Este celular no se pudo registrar para recibir avisos" }, 400);
      }
      await env.DB.prepare(`DELETE FROM fidelizacion_push WHERE endpoint = ?`).bind(endpoint).run();
      await env.DB.prepare(
        `INSERT INTO fidelizacion_push (comercio_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)`
      ).bind(comercio.id, endpoint, p256dh, auth).run();
      // Maximo 10 celulares por comercio: se va el mas viejo.
      await env.DB.prepare(
        `DELETE FROM fidelizacion_push WHERE comercio_id = ? AND id NOT IN
           (SELECT id FROM fidelizacion_push WHERE comercio_id = ? ORDER BY id DESC LIMIT ${MAX_CELULARES_POR_COMERCIO})`
      ).bind(comercio.id, comercio.id).run();
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/push/desuscribir" && method === "POST") {
    try {
      const body = await request.json();
      await env.DB.prepare(`DELETE FROM fidelizacion_push WHERE endpoint = ? AND comercio_id = ?`)
        .bind(String(body.endpoint || ""), comercio.id).run();
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (path === "/api/comercio/push/probar" && method === "POST") {
    try {
      const r = await enviarAvisoComercio(env, comercio.id, {
        title: "Aviso de prueba de Tapy",
        body: "Así te va a llegar cada moneda que se sume en tu club.",
        url: "/comercio.html",
        tag: "prueba"
      });
      return json({ ok: true, ...r });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const canjearMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/canjear$/);
  if (canjearMatch && method === "POST") {
    try {
      const cliente = await clienteDelComercio(env, comercio, canjearMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      if (!cliente.pendiente_canje) return json({ error: "Este cliente todavia no completo el nivel" }, 409);
      const premios = await premiosDeComercio(env, comercio.id);
      const premioDe = (n) => {
        const p = premios.find((x) => Number(x.nivel) === Number(n));
        return p && p.descripcion ? p.descripcion : null;
      };
      const esUltimo = Number(cliente.nivel_actual) >= Number(comercio.niveles);
      const nuevoNivel = esUltimo ? 1 : Number(cliente.nivel_actual) + 1;
      const vueltas = (Number(cliente.vueltas_completadas) || 0) + (esUltimo ? 1 : 0);
      // Condicional: si se toca "Entregar premio" dos veces, la segunda no hace nada.
      const upd = await env.DB.prepare(
        `UPDATE fidelizacion_clientes SET nivel_actual = ?, monedas_actuales = 0, pendiente_canje = 0, vueltas_completadas = ?, aviso_vencimiento_at = NULL
         WHERE id = ? AND pendiente_canje = 1 AND nivel_actual = ?`
      ).bind(nuevoNivel, vueltas, cliente.id, cliente.nivel_actual).run();
      if (!upd.meta || !upd.meta.changes) return json({ error: "Este premio ya se entregó recién" }, 409);
      await env.DB.prepare(
        `INSERT INTO fidelizacion_canjes (fidelizacion_cliente_id, nivel_canjeado) VALUES (?, ?)`
      ).bind(cliente.id, cliente.nivel_actual).run();
      return json({
        ok: true,
        nivel_canjeado: cliente.nivel_actual,
        premio_entregado: premioDe(cliente.nivel_actual),
        nuevo_nivel: nuevoNivel,
        nuevo_premio: premioDe(nuevoNivel),
        reinicio: esUltimo,
        vueltas_completadas: vueltas
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const ajustarMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/ajustar$/);
  if (ajustarMatch && method === "POST") {
    try {
      const body = await request.json();
      const delta = Number(body.delta);
      const cliente = await clienteDelComercio(env, comercio, ajustarMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      if (cliente.bloqueado) return json({ error: "La tarjeta de este cliente está bloqueada. Desbloqueala primero." }, 409);
      if (delta === 1) {
        if (cliente.pendiente_canje) return json({ error: "Este cliente ya completó el nivel. Entregale el premio primero." }, 409);
        const r = await acreditarMoneda(env, comercio, cliente, "manual");
        if (!r.acreditada) return json({ error: "Las monedas de este cliente acaban de cambiar. Actualizá y probá de nuevo." }, 409);
        return json({ ok: true, monedas_actuales: cliente.monedas_actuales, nivel_completo: r.nivelCompleto });
      }
      if (delta === -1) {
        if (!(cliente.monedas_actuales > 0)) return json({ error: "Este cliente no tiene monedas para restar" }, 409);
        // Condicional (evita bajar de 0 con doble clic). Si estaba esperando premio, el reloj
        // del vencimiento arranca de nuevo: sus monedas no pueden vencer de golpe por una correccion.
        const upd = await env.DB.prepare(
          `UPDATE fidelizacion_clientes
             SET monedas_actuales = monedas_actuales - 1,
                 ultimo_tap = CASE WHEN pendiente_canje = 1 THEN datetime('now') ELSE ultimo_tap END,
                 pendiente_canje = 0
           WHERE id = ? AND monedas_actuales = ?`
        ).bind(cliente.id, cliente.monedas_actuales).run();
        if (!upd.meta || !upd.meta.changes) return json({ error: "Las monedas de este cliente acaban de cambiar. Actualizá y probá de nuevo." }, 409);
        await env.DB.prepare(
          `INSERT INTO fidelizacion_taps (fidelizacion_cliente_id, delta, origen) VALUES (?, -1, 'manual')`
        ).bind(cliente.id).run();
        return json({ ok: true, monedas_actuales: cliente.monedas_actuales - 1, nivel_completo: false });
      }
      return json({ error: "Ajuste invalido" }, 400);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const avisoMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/aviso$/);
  if (avisoMatch && method === "POST") {
    try {
      const cliente = await clienteDelComercio(env, comercio, avisoMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      await env.DB.prepare(`UPDATE fidelizacion_clientes SET aviso_vencimiento_at = datetime('now') WHERE id = ?`).bind(cliente.id).run();
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const historialMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)\/historial$/);
  if (historialMatch && method === "GET") {
    try {
      const cliente = await clienteDelComercio(env, comercio, historialMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      const res = await env.DB.batch([
        env.DB.prepare(`SELECT id, ts, delta, origen, anulado, via FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ? ORDER BY id DESC LIMIT 200`).bind(cliente.id),
        env.DB.prepare(`SELECT id, ts, nivel_canjeado FROM fidelizacion_canjes WHERE fidelizacion_cliente_id = ? ORDER BY id DESC LIMIT 100`).bind(cliente.id)
      ]);
      const corte = await env.DB.prepare(
        `SELECT COALESCE(MAX(id), 0) AS n FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ? AND origen IN ('bloqueo', 'desbloqueo')`
      ).bind(cliente.id).first();
      const movimientos = (res[0].results || []).map((t) => ({
        id: t.id, ts: t.ts, tipo: t.origen, delta: t.delta, anulado: !!t.anulado, via: t.via || null,
        se_puede_advertir: tapAdvertible({ ...t, bloqueado: cliente.bloqueado, corte_adv: corte ? corte.n : 0 })
      }));
      const canjes = (res[1].results || []).map((k) => ({ ts: k.ts, tipo: "canje", nivel: k.nivel_canjeado }));
      const todo = movimientos.concat(canjes).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      return json({ cliente: { id: cliente.id, nombre: cliente.nombre, whatsapp: cliente.whatsapp, created_at: cliente.created_at, advertencias: Number(cliente.advertencias) || 0, bloqueado: !!cliente.bloqueado }, historial: todo });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  const clienteMatch = path.match(/^\/api\/comercio\/clientes\/(\d+)$/);
  if (clienteMatch && method === "DELETE") {
    try {
      const cliente = await clienteDelComercio(env, comercio, clienteMatch[1]);
      if (!cliente) return json({ error: "Cliente no encontrado" }, 404);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM fidelizacion_taps WHERE fidelizacion_cliente_id = ?`).bind(cliente.id),
        env.DB.prepare(`DELETE FROM fidelizacion_canjes WHERE fidelizacion_cliente_id = ?`).bind(cliente.id),
        env.DB.prepare(`DELETE FROM fidelizacion_clientes WHERE id = ?`).bind(cliente.id)
      ]);
      return json({ ok: true });
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
