import type { Config, Context } from "@netlify/functions";
import { recordInteraction, verifyTrackingToken } from "../lib/tracking.mts";

export default async function trackClick(request: Request, context: Context): Promise<Response> {
  const token = context.params.token ?? "";
  const payload = await verifyTrackingToken(token).catch(() => null);
  if (payload?.k !== "click" || !payload.u) {
    return new Response("Lien invalide ou expiré.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  await recordInteraction({ token, payload, userAgent: request.headers.get("user-agent") }).catch(() => false);
  return new Response(null, {
    status: 302,
    headers: {
      Location: payload.u,
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const config: Config = {
  path: "/t/c/:token",
  method: "GET",
};
