import { json, errorResponse } from "../../_utils.js";

export async function onRequestGet(context) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { results: clients } = await context.env.DB.prepare(
      `SELECT * FROM clients
       WHERE next_report_date IS NOT NULL
         AND next_report_date <= ?
         AND status != 'suspendido'`
    ).bind(today).all();

    const withCounts = [];
    for (const client of clients) {
      const since = client.last_report_sent || client.signup_date;

      const { results: chipRows } = await context.env.DB.prepare(
        `SELECT id, label, slug FROM chips WHERE client_id = ?`
      ).bind(client.id).all();

      const chips = [];
      for (const chip of chipRows) {
        const countRow = await context.env.DB.prepare(
          `SELECT COUNT(*) AS total FROM taps WHERE chip_id = ? AND ts >= ?`
        ).bind(chip.id, since).first();
        chips.push({ ...chip, taps_period: countRow ? countRow.total : 0 });
      }

      withCounts.push({ ...client, chips, period_since: since, period_until: today });
    }

    return json(withCounts);
  } catch (err) {
    return errorResponse(err);
  }
}
