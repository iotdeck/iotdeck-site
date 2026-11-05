import { handle } from "./lib/core.js";

// Server routes go to the API code; everything else is served from public/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // www.iotdeck.org goes to the main domain. The workers.dev address stays as is: devices use it.
    if (url.hostname === "www.iotdeck.org") {
      url.hostname = "iotdeck.org";
      return Response.redirect(url.toString(), 301);
    }
    const { pathname } = url;
    if (pathname.startsWith("/api/") || pathname === "/ingest" || pathname.startsWith("/ws/")) {
      return handle(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
