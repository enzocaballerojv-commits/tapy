import { json, errorResponse } from "../_utils.js";

export async function onRequestGet(context) {
  try {
    const { results } = await context.env.DB.prepare(`SELECT key, value FROM settings`).all();
    const obj = {};
    results.forEach((r) => { obj[r.key] = r.value; });
    return json(obj);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    for (const [key, value] of Object.entries(body)) {
      await context.env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, String(value)).run();
    }
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
