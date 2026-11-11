const localAuthUrl = "http://localhost:54321/auth";

export function resolveNeonAuthUrl(value: string | undefined, production: boolean): string {
  const configured = value?.trim();
  if (!configured) {
    if (production) throw new Error("VITE_NEON_AUTH_URL is required for a production build.");
    return localAuthUrl;
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("VITE_NEON_AUTH_URL must be a valid authentication URL.");
  }
  if (production && (url.protocol !== "https:" || url.username || url.password
    || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("VITE_NEON_AUTH_URL must use a public HTTPS endpoint in production.");
  }
  return configured;
}
