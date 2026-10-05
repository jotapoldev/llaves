"use strict";
/**
 * LLAVES: página, API de salas y sincronización en vivo (SSE).
 *
 * - Cada torneo vive en una "sala" con un código corto para compartir.
 * - Quien crea la sala recibe una clave de edición; los demás solo ven.
 * - Todo vive en memoria: nada se guarda en disco ni en base de datos.
 *   Una sala se borra sola SALA_TTL_HORAS después de su último cambio.
 *
 * Variables de entorno (todas opcionales):
 *   PORT              puerto (3000)
 *   SALA_TTL_HORAS    horas sin cambios antes de borrar una sala (24)
 *   MAX_SALAS         salas activas como máximo (500)
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TTL_MS = (Number(process.env.SALA_TTL_HORAS) || 24) * 3600 * 1000;
const MAX_SALAS = Number(process.env.MAX_SALAS) || 500;
const MAX_ESPECTADORES = 300;      // conexiones en vivo por sala
const CREAR_POR_HORA = 15;         // salas nuevas por IP por hora

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);          // Railway pone un proxy delante: la IP real viene en X-Forwarded-For
app.use(express.json({ limit: "512kb" }));

/* ---------- cabeceras de seguridad ---------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/* ---------- salas en memoria ---------- */
const salas = new Map(); // codigo -> { state, keyHash, updated, clients:Set }
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin 0/O, 1/I/L

function nuevoCodigo() {
  for (;;) {
    const b = crypto.randomBytes(6);
    const c = Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join("");
    if (!salas.has(c)) return c;
  }
}
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
function claveValida(sala, key) {
  if (typeof key !== "string" || !key) return false;
  return crypto.timingSafeEqual(sala.keyHash, hash(key));
}
function sala(req, res) {
  const s = salas.get(String(req.params.codigo || "").toUpperCase());
  if (!s) res.status(404).json({ error: "La sala no existe o ya expiró." });
  return s;
}

// Borra salas sin cambios dentro del TTL.
setInterval(() => {
  const limite = Date.now() - TTL_MS;
  for (const [c, s] of salas) {
    if (s.updated < limite) {
      for (const r of s.clients) { try { r.end(); } catch (_) {} }
      salas.delete(c);
    }
  }
}, 10 * 60 * 1000).unref();

// Límite simple de creación por IP (ventana de una hora).
const creaciones = new Map();
function puedeCrear(ip) {
  const ahora = Date.now();
  const v = (creaciones.get(ip) || []).filter((t) => ahora - t < 3600 * 1000);
  if (v.length >= CREAR_POR_HORA) { creaciones.set(ip, v); return false; }
  v.push(ahora);
  creaciones.set(ip, v);
  return true;
}
setInterval(() => creaciones.clear(), 3600 * 1000).unref();

function broadcast(s) {
  const payload = "data: " + JSON.stringify({ state: s.state }) + "\n\n";
  for (const r of s.clients) { try { r.write(payload); } catch (_) {} }
}

/* ---------- API ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true, salas: salas.size }));

app.post("/api/salas", (req, res) => {
  if (salas.size >= MAX_SALAS) return res.status(503).json({ error: "Hay demasiadas salas activas. Probá en un rato." });
  if (!puedeCrear(req.ip)) return res.status(429).json({ error: "Creaste muchas salas seguidas. Esperá unos minutos." });
  const codigo = nuevoCodigo();
  const key = crypto.randomBytes(18).toString("base64url");
  salas.set(codigo, { state: null, keyHash: hash(key), updated: Date.now(), clients: new Set() });
  res.status(201).json({ codigo, key, expiraEnHoras: TTL_MS / 3600000 });
});

app.get("/api/salas/:codigo", (req, res) => {
  const s = sala(req, res); if (!s) return;
  res.set("Cache-Control", "no-store").json({ state: s.state });
});

app.post("/api/salas/:codigo/verificar", (req, res) => {
  const s = sala(req, res); if (!s) return;
  res.json({ ok: claveValida(s, req.get("x-edit-key")) });
});

app.post("/api/salas/:codigo", (req, res) => {
  const s = sala(req, res); if (!s) return;
  if (!claveValida(s, req.get("x-edit-key"))) return res.status(401).json({ error: "Clave de edición incorrecta." });
  const state = req.body ? req.body.state : undefined;
  if (state !== null && (typeof state !== "object" || Array.isArray(state))) return res.status(400).json({ error: "Estado inválido." });
  s.state = state;
  s.updated = Date.now();
  broadcast(s);
  res.json({ ok: true });
});

app.get("/api/salas/:codigo/eventos", (req, res) => {
  const s = sala(req, res); if (!s) return;
  if (s.clients.size >= MAX_ESPECTADORES) return res.status(503).json({ error: "La sala está llena." });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  if (res.flushHeaders) res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.write("data: " + JSON.stringify({ state: s.state }) + "\n\n");
  s.clients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(ping); s.clients.delete(res); });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada." }));

/* ---------- página ---------- */
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, file) => { if (file.endsWith(".html")) res.set("Cache-Control", "no-cache"); },
}));

app.listen(PORT, () => console.log("LLAVES en http://localhost:" + PORT + " (salas en memoria, TTL " + TTL_MS / 3600000 + " h)"));
