/** A JSON response, as every answer from the Worker and the mesh object is. */
export function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
