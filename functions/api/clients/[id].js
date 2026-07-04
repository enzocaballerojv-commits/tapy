import { json, errorResponse } from "../../_utils.js";

const EDITABLE_FIELDS = [
  "name", "business_type", "contact_name", "whatsapp", "plan", "billing_freq",
  "price_one_time", "price_recurring", "due_date", "status",
  "next_report_date", "last_report_sent", "notes"
];

export async function onRequestGet(context) {
  try {
    const id = context.params.id;
    const client = await context.env.DB.prepare(`SELECT * FROM clients WHERE id = ?`).bind(id).first();
    if (!client) return errorResponse("Cliente no encontrado", 404);

    const { results: chips } = await context.env.DB.prepare(
      `SELECT * FROM chips WHERE client_id = ?`
    ).bind(id).all();

    return json({ ...client, chips });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestPatch(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();

    const fields = Object.keys(body).filter((k) => EDITABLE_FIELDS.includes(k));
    if (fields.length === 0) return errorResponse("Nada válido para actualizar", 400);

    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);

    await context.env.DB.prepare(
      `UPDATE clients SET ${setClause} WHERE id = ?`
    ).bind(...values, id).run();

    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
