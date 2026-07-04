export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.PANEL_PASSWORD) {
    return new Response(
      JSON.stringify({ error: "El panel no tiene contraseña configurada" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!body.password || body.password !== env.PANEL_PASSWORD) {
    return new Response(JSON.stringify({ error: "Contraseña incorrecta" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `panel_auth=${encodeURIComponent(body.password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
