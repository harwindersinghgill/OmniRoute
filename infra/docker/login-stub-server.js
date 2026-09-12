const http = require("http");
// LEGACY stub (interim only). Prod uses full Next.js standalone via runner-from-artifacts after host build succeeds. 2026-07-10 full-app fix. # full-app-2026-07-10
const PASSWORD = process.env.INITIAL_PASSWORD;
if (!PASSWORD || PASSWORD.length < 10) {
  console.error("FATAL: INITIAL_PASSWORD env var missing or too short");
  process.exit(1);
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", service: "omniroute", timestamp: new Date().toISOString() })
    );
  } else if (req.url === "/login" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><title>OmniRoute Login</title></head>
<body style="font-family:sans-serif;max-width:400px;margin:40px auto">
<h1>OmniRoute</h1>
<p>Login (password only)</p>
<form method="post" action="/api/auth/login">
  <input type="password" name="password" placeholder="enter INITIAL_PASSWORD" style="width:100%;padding:8px" />
  <button type="submit" style="margin-top:8px;padding:8px">Login</button>
</form>
<p style="color:#666;font-size:12px">Use the strong INITIAL_PASSWORD provided in the user guide / login-creds (from setup).<br/>Full UI available after full build.</p>
</body></html>`);
  } else if (req.url === "/api/auth/login" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submitted = params.get("password") || "";
      if (submitted === PASSWORD) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            token: "stub-session",
            message: "Correct password. Full app will use real auth.",
          })
        );
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Invalid password." }));
      }
    });
    return;
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found (stub pending full build)");
  }
});
server.listen(20128, "0.0.0.0", () =>
  console.log(
    "LEGACY stub only (runner-login-stub DO NOT TARGET); 2026-07-10 full AC1 requires real Next.js via runner-from-artifacts + .build/next/standalone"
  )
);
