// Funciones compartidas para no repetir código en cada endpoint

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function errorResponse(err, status = 500) {
  const message = typeof err === "string" ? err : "Error interno del servidor";
  if (err instanceof Error) console.error(err);
  return json({ error: message }, status);
}
