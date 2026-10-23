import type { Config, Context } from "@netlify/functions";
import { recordInteraction, verifyTrackingToken } from "../lib/tracking.mts";

const PIXEL = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");

function pixel(): Response {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.byteLength),
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export default async function trackOpen(request: Request, context: Context): Promise<Response> {
  const token = context.params.token ?? "";
  const payload = await verifyTrackingToken(token).catch(() => null);
  if (payload?.k === "open") {
    await recordInteraction({ token, payload, userAgent: request.headers.get("user-agent") }).catch(() => false);
  }
  return pixel();
}

export const config: Config = {
  path: "/t/o/:token",
  method: "GET",
};
