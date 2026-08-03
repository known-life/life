/**
 * `Response.json()` is typed `unknown`, and that is correct — the wire carries
 * no type, so TypeScript refuses to invent one. A test that asserts on a body's
 * fields has to name the shape it expects.
 *
 * This is that cast, declared once rather than re-spelled at every call. The
 * default keeps the VALUES unknown and only admits indexing, so a field still
 * has to be asserted rather than trusted; pass `T` where a test wants the real
 * contract checked.
 */
export async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
