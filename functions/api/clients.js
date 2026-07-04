import { json, errorResponse } from "../_utils.js";

export async function onRequestGet(context) {
  try {
    const { results } = await context.env.DB.prepare(
      `SELECT * FROM clients ORDER BY due_date ASC`
    ).all();
    return json(results);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    if (!body.name || !body.plan || !body.signup_date) {
      return errorResponse("Faltan campos obligatorios: name, plan, signup_date", 400);
    }

    const result = await context.env.DB.prepare(
      `INSERT INTO clients
        (name, business_type, contact_name, whatsapp, signup_date, plan, billing_freq,
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
    return errorResponse(err);
  }
}
