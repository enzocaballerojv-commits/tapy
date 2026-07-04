import { json, errorResponse } from "../../_utils.js";

const EDITABLE_FIELDS = ["label", "destination_url", "suspended_url", "password_note"];

export async function onRequestPatch(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();

    const fields = Object.keys(body).filter((k) => EDITABLE_FIELDS.includes(k));
    if (fields.length === 0) return errorResponse("Nada válido para actualizar", 400);

    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => body[f]);

    await context.env.DB.prepare(
      `UPDATE chips SET ${setClause}, last_reprogrammed = datetime('now') WHERE id = ?`
    ).bind(...values, id).run();

    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
