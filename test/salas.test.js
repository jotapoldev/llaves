// node --test: levanta el servidor y prueba el ciclo de una sala.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 3399;
const B = `http://localhost:${PORT}`;
let srv;

before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT } });
  for (let i = 0; i < 50; i++) {
    try { await fetch(B + "/api/health"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => srv.kill());

test("crear, leer y editar una sala solo con su clave", async () => {
  const r = await fetch(B + "/api/salas", { method: "POST" });
  assert.equal(r.status, 201);
  const { codigo, key } = await r.json();
  assert.match(codigo, /^[A-Z2-9]{6}$/);

  const post = (k, state) => fetch(`${B}/api/salas/${codigo}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-edit-key": k }, body: JSON.stringify({ state }),
  });
  assert.equal((await post("otra", { teams: [] })).status, 401);
  assert.equal((await post(key, { teams: ["A", "B"] })).status, 200);
  assert.deepEqual((await (await fetch(`${B}/api/salas/${codigo.toLowerCase()}`)).json()).state, { teams: ["A", "B"] });
  assert.equal((await post(key, [1, 2])).status, 400);
});

test("sala inexistente da 404 y la página manda cabeceras de seguridad", async () => {
  assert.equal((await fetch(B + "/api/salas/ZZZZZZ")).status, 404);
  const h = (await fetch(B + "/")).headers;
  assert.match(h.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(h.get("x-content-type-options"), "nosniff");
});
