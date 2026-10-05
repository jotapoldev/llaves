# LLAVES

Generador de torneos con llaves en vivo. Armás el torneo, marcás los resultados y todos los que tengan el link lo ven actualizarse al instante, sin recargar.

![Torneo en vivo](docs/screenshots/en-vivo.png)

- **Tres formatos:** liga (ida o ida y vuelta), eliminación directa y doble eliminación con gran final.
- **En vivo:** el organizador edita con una clave; los demás ven los cambios en tiempo real (Server-Sent Events).
- **Posiciones automáticas:** tabla de liga con goles y diferencia; en eliminación, hasta qué ronda llegó cada equipo.
- **PDF tipo póster:** imprime el cuadro con el campeón al centro.
- **Historial:** guarda torneos terminados y los vuelve a abrir.
- **Exportar e importar** cualquier torneo en JSON.

| Configurar | En el celular |
| --- | --- |
| ![Configurar torneo](docs/screenshots/configurar.png) | ![Vista móvil](docs/screenshots/movil.png) |

## Correrlo

Necesitás Node 18 o más nuevo.

```bash
npm install
ADMIN_KEY=tu-clave npm start
```

Abrí http://localhost:3000, tocá **Editar** y escribí tu clave. Si no definís `ADMIN_KEY`, se genera una al arrancar y sale en la consola.

Sin base de datos, el torneo vive en memoria. Para que sobreviva a reinicios, definí `DATABASE_URL` con una conexión de Postgres; las tablas se crean solas.

| Variable | Para qué |
| --- | --- |
| `ADMIN_KEY` | Clave para editar. Sin ella se genera una por arranque. |
| `DATABASE_URL` | Postgres opcional para guardar el torneo y el historial. |
| `ALLOWED_ORIGIN` | Solo si servís la página desde otro dominio (CORS). Varios separados por coma. |
| `PORT` | Puerto, 3000 por defecto. |

## Cómo está hecho

Un solo `server.js` (Express) sirve la página y la API en el mismo puerto. La página es un único `public/index.html` sin build ni framework.

| Ruta | Quién | Qué hace |
| --- | --- | --- |
| `GET /api/state` | todos | Torneo activo |
| `GET /api/events` | todos | Cambios en vivo (SSE) |
| `POST /api/state` | admin | Guarda y avisa a todos |
| `GET /api/history` | todos | Torneos guardados |

---

## English

LLAVES is a live tournament bracket generator: league, single elimination and double elimination. The organizer edits with a key and everyone with the link sees results update in real time (Server-Sent Events). It includes automatic standings, a poster-style PDF, saved history, and JSON import and export.

```bash
npm install
ADMIN_KEY=your-key npm start   # http://localhost:3000
```

Set `DATABASE_URL` (Postgres) to persist tournaments across restarts.

---

Licencia [Apache-2.0](LICENSE). Hecho por **jotapol_** · [JOTAPOL DEV](https://github.com/jotapoldev)
