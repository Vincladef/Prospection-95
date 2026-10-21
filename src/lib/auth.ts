import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const fallbackUrl = "http://localhost:54321/auth";
export const authUrl = import.meta.env.VITE_NEON_AUTH_URL || fallbackUrl;

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getAccessToken(): Promise<string> {
  const { data, error } = await authClient.token();
  if (error || !data?.token) {
    throw new Error(error?.message || "Session expirée. Reconnectez-vous.");
  }
  return data.token;
}
