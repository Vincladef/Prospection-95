import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const fallbackUrl = "http://localhost:54321/auth";
export const authUrl = import.meta.env.VITE_NEON_AUTH_URL || fallbackUrl;

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getAccessToken(): Promise<string> {
  // @neondatabase/auth 0.6.0-beta classifies /token like /get-session and can
  // serve the cached session object instead of fetching the JWT. Its adapter
  // consumes this internal header before the network request and bypasses that
  // cache for the token call only.
  const { data, error } = await authClient.token({
    fetchOptions: {
      headers: { "X-Force-Fetch": "true" },
    },
  });
  if (error || !data?.token) {
    throw new Error(error?.message || "Session expirée. Reconnectez-vous.");
  }
  return data.token;
}
