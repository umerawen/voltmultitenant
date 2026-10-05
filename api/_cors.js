// The phone app (Capacitor) runs on its own origin — capacitor://localhost on
// iOS, https://localhost on Android — and calls these functions on the site,
// so the web view asks first (a CORS preflight). Only the app's origins get an
// answer; the website is same-origin and never needs one. Auth is still the
// Bearer token every handler checks, not the origin.
//
// Files starting with "_" are not deployed as functions by Vercel.
const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);

// Returns true when it has answered the request itself (the preflight).
export function cors(req, res) {
  const o = req.headers.origin;
  if (o && APP_ORIGINS.has(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}
