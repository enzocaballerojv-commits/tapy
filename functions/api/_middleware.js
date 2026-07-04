// Protege todo lo que esté bajo /api/ con una contraseña simple.
// No protege /c/[slug] (eso tiene que quedar público, es lo que tocan los clientes finales).

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // El login tiene que quedar abierto, sino nadie puede loguearse nunca
  if (url.pathname === "/api/login") {
    return next();
  }

  if (!env.PANEL_PASSWORD) {
    return new Response(
      JSON.stringify({ error: "El panel no tiene contraseña configurada (falta la variable PANEL_PASSWORD)" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/panel_auth=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (token !== env.PANEL_PASSWORD) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  return next();
}
