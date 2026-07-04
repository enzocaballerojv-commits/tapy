import { json, errorResponse } from "../_utils.js";

export async function onRequestGet(context) {
  try {
    const { results } = await context.env.DB.prepare(
      `SELECT chips.*, clients.name AS client_name, clients.status AS client_status
       FROM chips
       JOIN clients ON chips.client_id = clients.id
       ORDER BY clients.name`
    ).all();
    return json(results);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    if (!body.client_id || !body.slug || !body.destination_url) {
      return errorResponse("Faltan campos obligatorios: client_id, slug, destination_url", 400);
    }

    const existing = await context.env.DB.prepare(
      `SELECT id FROM chips WHERE slug = ?`
    ).bind(body.slug).first();
    if (existing) return errorResponse("Ese slug ya existe, elegí otro", 409);

    const result = await context.env.DB.prepare(
      `INSERT INTO chips (client_id, slug, label, destination_url, suspended_url, password_note)
       VALUES (?,?,?,?,?,?)`
    ).bind(
      body.client_id,
      body.slug,
      body.label || null,
      body.destination_url,
      body.suspended_url || "https://tuservicio.pages.dev/error.html",
      body.password_note || null
    ).run();

    return json({ id: result.meta.last_row_id });
  } catch (err) {
    return errorResponse(err);
  }
}
