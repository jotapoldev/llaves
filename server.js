"use strict";
/**
 * LLAVES: servidor de la página, API y sincronización en vivo (SSE).
 *
 * - Sirve public/index.html y la API en el mismo puerto.
 * - Guarda el torneo activo y el historial en Postgres si hay DATABASE_URL;
 *   si no, en memoria.
 * - Solo quien manda la cabecera x-admin-key === ADMIN_KEY puede editar;
 *   los demás ven en vivo.
 *
 * Variables de entorno:
 *   ADMIN_KEY        clave para editar (sin ella se genera una al arrancar).
 *   DATABASE_URL     conexión Postgres (opcional).
 *   ALLOWED_ORIGIN   orígenes permitidos para CORS si la página vive en otro
 *                    dominio; separados por coma. Por defecto "*".
 *   PORT             puerto (3000 por defecto).
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "4mb" }));

// Sin ADMIN_KEY se genera una clave aleatoria por arranque (nunca una fija conocida).
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(9).toString("base64url");
if (!process.env.ADMIN_KEY) console.log("ADMIN_KEY no definida; clave de esta sesión: " + ADMIN_KEY);
const PORT = process.env.PORT || 3000;
const USE_PG = !!process.env.DATABASE_URL;
const ORIGINS = (process.env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim());

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (ORIGINS.includes("*")) res.set("Access-Control-Allow-Origin", "*");
  else if (origin && ORIGINS.includes(origin)) res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- storage ---------- */
let mem = null;          // torneo activo
let memHistory = [];     // historial (fallback en memoria)
let pool = null;

if (USE_PG) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function initDb() {
  if (!USE_PG) return;
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb, updated_at timestamptz DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS history (id text PRIMARY KEY, name text, date bigint, data jsonb)"
  );
}

async function getState() {
  if (!USE_PG) return mem;
  const r = await pool.query("SELECT data FROM app_state WHERE id = 1");
  return r.rows[0] ? r.rows[0].data : null;
}

async function setState(data) {
  if (!USE_PG) { mem = data; return; }
  await pool.query(
    "INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) " +
    "ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()",
    [data]
  );
}

/* ---------- history (torneos guardados) ---------- */
async function getHistory() {
  if (!USE_PG) return memHistory.slice().sort((a, b) => b.date - a.date);
  const r = await pool.query("SELECT id, name, date, data FROM history ORDER BY date DESC");
  return r.rows.map(row => ({ id: row.id, name: row.name, date: Number(row.date), state: row.data }));
}
async function upsertHistory(entry) {
  if (!USE_PG) {
    const i = memHistory.findIndex(e => e.id === entry.id);
    if (i >= 0) memHistory[i] = entry; else memHistory.push(entry);
    return;
  }
  await pool.query(
    "INSERT INTO history (id, name, date, data) VALUES ($1, $2, $3, $4) " +
    "ON CONFLICT (id) DO UPDATE SET name = $2, date = $3, data = $4",
    [entry.id, entry.name, entry.date, entry.state]
  );
}
async function deleteHistory(id) {
  if (!USE_PG) { memHistory = memHistory.filter(e => e.id !== id); return; }
  await pool.query("DELETE FROM history WHERE id = $1", [id]);
}

/* ---------- SSE ---------- */
const clients = new Set();
function broadcast(state) {
  const payload = "data: " + JSON.stringify({ state }) + "\n\n";
  for (const res of clients) {
    try { res.write(payload); } catch (_) { /* ignore */ }
  }
}

/* ---------- API ---------- */
function isAdmin(req) { return req.get("x-admin-key") === ADMIN_KEY; }

app.get("/api/health", (req, res) => res.json({ ok: true, service: "llaves" }));

app.get("/api/state", async (req, res) => {
  try { res.json({ state: await getState() }); }
  catch (e) { console.error(e); res.status(500).json({ error: "db" }); }
});

app.get("/api/admin/verify", (req, res) => res.json({ ok: isAdmin(req) }));

app.post("/api/state", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  const state = req.body ? req.body.state : null;
  try { await setState(state); broadcast(state); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "db" }); }
});

/* ---------- history endpoints ---------- */
app.get("/api/history", async (req, res) => {
  try { res.json({ items: await getHistory() }); }
  catch (e) { console.error(e); res.status(500).json({ error: "db" }); }
});

app.post("/api/history", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  const entry = req.body ? req.body.entry : null;
  if (!entry || !entry.id) return res.status(400).json({ error: "bad_entry" });
  try { await upsertHistory(entry); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "db" }); }
});

app.delete("/api/history", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "no_id" });
  try { await deleteHistory(String(id)); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "db" }); }
});

app.get("/api/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write("retry: 3000\n\n");
  try { res.write("data: " + JSON.stringify({ state: await getState() }) + "\n\n"); }
  catch (_) { /* ignore */ }
  clients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

/* ---------- página ---------- */
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, file) => { if (file.endsWith(".html")) res.set("Cache-Control", "no-cache"); },
}));

/* ---------- boot ---------- */
initDb()
  .then(() => app.listen(PORT, () => console.log("LLAVES en http://localhost:" + PORT + (USE_PG ? " (Postgres)" : " (memoria)"))))
  .catch((e) => {
    console.error("DB init falló:", e.message);
    app.listen(PORT, () => console.log("LLAVES en http://localhost:" + PORT + " (memoria, DB falló)"));
  });
