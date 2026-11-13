// Where the Changi Board Worker API lives.
//
// Set this to the Worker URL printed by `wrangler deploy`, for example
//   window.CHANGI_API = "https://changi-board.<your-subdomain>.workers.dev";
// Leave it empty to call the same origin (e.g. if the Worker is routed at
// <your-domain>/api/*). On localhost it defaults to `wrangler dev` (port 8787).
// Same origin: flightlah.com/api/* is routed to the changi-board Worker on the
// zone, so the password-gate cookie (fl_gate) travels with every API call.
// (Cross-origin calls to *.workers.dev would not carry the cookie on iOS Safari.)
window.CHANGI_API = "";
