// Shared helpers for e2e tests — read bodies captured by mock-upstream.
export async function mockBodies(): Promise<any[]> {
  const r = await fetch("http://localhost:9991/_bodies");
  return r.json();
}
export function lastBody(): any {
  // convenience wrapper filled by caller via await mockBodies(); kept for compat
  throw new Error("use `const bodies = await mockBodies(); bodies[bodies.length-1]` instead");
}
