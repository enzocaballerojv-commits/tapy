// Se ejecuta en Cloudflare Pages Functions cuando alguien toca un chip
// URL real: tuservicio.pages.dev/c/nombre-del-cliente
//
// Regla de oro de este archivo: el usuario final SIEMPRE tiene que terminar
// en algún lado (nunca una pantalla de error en blanco), pase lo que pase
// del lado del servidor o de la base de datos.

const FALLBACK_URL = "https://tuservicio.pages.dev/error.html";

export async function onRequestGet(context) {
  const { params, env } = context;
  const slug = params.slug;

  try {
    if (!slug) {
      return Response.redirect(FALLBACK_URL, 302);
    }

    // Busca el chip y el estado del cliente al que pertenece en una sola consulta
    const row = await env.DB.prepare(
      `SELECT chips.id AS chip_id,
              chips.destination_url,
              chips.suspended_url,
              clients.status
       FROM chips
       JOIN clients ON chips.client_id = clients.id
       WHERE chips.slug = ?`
    ).bind(slug).first();

    // Chip inexistente (mal escrito, borrado, nunca dado de alta) -> fallback, nunca error crudo
    if (!row) {
      return Response.redirect(FALLBACK_URL, 302);
    }

    // Registra el toque sin bloquear la redirección.
    // waitUntil deja que esto termine en segundo plano aunque ya se respondió al usuario.
    context.waitUntil(
      env.DB.prepare(`INSERT INTO taps (chip_id) VALUES (?)`)
        .bind(row.chip_id)
        .run()
        .catch(() => {
          // Si falla el registro del toque, no importa: el usuario ya fue redirigido.
          // Preferimos perder un conteo antes que romper la experiencia del cliente final.
        })
    );

    // Cliente suspendido por atraso -> página neutra, nunca el destino real
    if (row.status === "suspendido") {
      return Response.redirect(row.suspended_url || FALLBACK_URL, 302);
    }

    // Chip sin destino configurado (alta incompleta) -> fallback
    if (!row.destination_url) {
      return Response.redirect(FALLBACK_URL, 302);
    }

    // Caso normal: redirige al link real del comercio (reseña, Instagram, menú, etc.)
    return Response.redirect(row.destination_url, 302);

  } catch (err) {
    // Cualquier error inesperado (base de datos caída, etc.) -> fallback, nunca una pantalla rota
    return Response.redirect(FALLBACK_URL, 302);
  }
}
