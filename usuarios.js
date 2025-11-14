// usuarios.js
"use strict";

const express = require("express");
const os = require("os");
const { execFile } = require("child_process");
const { listUsers, createUser, updateUser, deleteUser } = require("./db");

function createUsersRouter({ ensureAuth } = {}) {
  const router = express.Router();
  if (ensureAuth) router.use(ensureAuth);
  router.use(express.json());

  // ====== Métricas
  const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024;
  const fmtB = (b) =>
    b >= TB ? (b / TB).toFixed(2) + " TB" :
    b >= GB ? (b / GB).toFixed(2) + " GB" :
    b >= MB ? (b / MB).toFixed(2) + " MB" :
    b >= KB ? (b / KB).toFixed(2) + " KB" :
    b + " B";

  const snapshotCpu = () => {
    const cpus = os.cpus() || [];
    let idle = 0, total = 0;
    for (const c of cpus) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    return { idle, total, cores: cpus.length };
  };
  const cpuPct = (a, b) => {
    const idle = b.idle - a.idle;
    const total = b.total - a.total;
    if (total <= 0) return 0;
    return ((total - idle) / total) * 100;
  };

  const getDisk = (p = "/") =>
    new Promise((resolve, reject) => {
      execFile("df", ["-kP", p], { timeout: 3000 }, (err, out) => {
        if (err) return reject(err);
        const lines = String(out || "").trim().split("\n");
        if (lines.length < 2) return reject(new Error("df vacío"));
        const parts = lines[1].trim().split(/\s+/);
        const blocksK = parseInt(parts[1], 10) || 0;
        const usedK   = parseInt(parts[2], 10) || 0;
        const availK  = parseInt(parts[3], 10) || 0;
        const capText = parts[4];
        const mount   = parts[5];
        const total   = blocksK * 1024;
        const used    = usedK * 1024;
        const avail   = availK * 1024;
        let usedPct   = Number(String(capText).replace("%", ""));
        if (!Number.isFinite(usedPct)) usedPct = total ? (used / total) * 100 : 0;
        resolve({
          filesystem: parts[0],
          mount,
          totalBytes: total,
          usedBytes: used,
          availBytes: avail,
          usedPct,
          freePct: 100 - usedPct,
          totalHuman: fmtB(total),
          availHuman: fmtB(avail),
        });
      });
    });

  // ====== SSE (CPU/RAM/DISCO en tiempo real)
  router.get("/api/monitor/events", async (req, res) => {
    const path = (typeof req.query.path === "string" && req.query.path.trim())
      ? req.query.path.trim()
      : "/";
    const intervalMs = Math.max(300, parseInt(req.query.ms || "1000", 10));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let prev = snapshotCpu();

    const tick = async () => {
      try {
        const next = snapshotCpu();
        const cpu = Math.max(0, Math.min(100, cpuPct(prev, next) || 0));
        prev = next;

        // RAM
        const total = os.totalmem();
        const free  = os.freemem();
        const used  = total - free;
        const ramPct = total ? (used / total) * 100 : 0;

        const disk = await getDisk(path).catch(() => null);

        res.write(
          `data:${JSON.stringify({
            now: new Date().toISOString(),
            cpuPct: cpu,
            cores: next.cores,
            loadAvg: (os.loadavg() || []).map((n) => (n || 0).toFixed(2)),
            ram: {
              totalBytes: total,
              usedBytes: used,
              freeBytes: free,
              usedPct: ramPct,
              totalHuman: fmtB(total),
              usedHuman: fmtB(used),
              freeHuman: fmtB(free),
            },
            disk,
          })}\n\n`
        );
      } catch {
        /* ignore */
      }
    };

    tick();
    const it = setInterval(tick, intervalMs);
    req.on("close", () => clearInterval(it));
  });

  // ====== UI
  router.get("/usuarios", (_req, res) => res.type("html").send(renderPage()));

  // ====== API Users
  router.get("/api/users", (req, res) => res.json({ users: listUsers() }));

  router.post("/api/users", (req, res) => {
    const { email = "", password = "", active = true } = req.body || {};
    try {
      if (!email || !password) {
        return res.status(400).json({ error: "email y password son requeridos" });
      }
      const u = createUser(String(email).trim(), String(password), { active: !!active });
      res.json({ user: u });
    } catch (e) {
      res.status(400).json({ error: e.message || "Error al crear usuario" });
    }
  });

  router.put("/api/users/:id", (req, res) => {
    const id = +req.params.id;
    const { email, password, active } = req.body || {};
    try {
      const u = updateUser(id, {
        email: typeof email === "string" ? email : undefined,
        password: typeof password === "string" && password.length ? password : undefined,
        active: typeof active === "boolean" ? active : undefined,
      });
      res.json({ user: u });
    } catch (e) {
      res.status(400).json({ error: e.message || "Error al actualizar usuario" });
    }
  });

  router.delete("/api/users/:id", (req, res) => {
    const id = +req.params.id;
    try {
      deleteUser(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || "Error al eliminar usuario" });
    }
  });

  return router;
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Usuarios — SkyUltraPlus</title>
<style>
  :root{
    --bg:#ffffff;
    --fg:#0f172a;
    --muted:#64748b;
    --ring:#e5e7eb;
    --primary:#111827;
    --accent:#2563eb
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    background:var(--bg);
    color:var(--fg);
    font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial
  }
  header{
    display:flex;
    align-items:center;
    gap:12px;
    padding:14px 18px;
    border-bottom:1px solid var(--ring)
  }
  header img{width:40px;height:40px}
  h1{font-size:18px;margin:0}
  .sub{font-size:12px;color:var(--muted)}
  main{
    max-width:1000px;
    margin:0 auto;
    padding:20px;
    display:grid;
    gap:18px
  }
  .card{
    border:1px solid var(--ring);
    border-radius:12px;
    padding:16px
  }
  .row{display:grid;gap:10px}
  .grid{display:grid;gap:12px}
  .grid.cols-2{grid-template-columns:1fr 1fr}
  label{font-size:12px;color:var(--muted)}
  input,select{
    width:100%;
    padding:10px 12px;
    border:1px solid var(--ring);
    border-radius:10px;
    font-size:14px
  }
  button{
    padding:10px 12px;
    border:none;
    border-radius:10px;
    background:var(--primary);
    color:#fff;
    font-weight:600;
    cursor:pointer
  }
  button.secondary{background:#334155}
  table{width:100%;border-collapse:collapse}
  th,td{
    padding:10px;
    border-bottom:1px solid var(--ring);
    text-align:left;
    font-size:14px
  }
  .metric{display:flex;align-items:center;gap:12px}
  .bar{
    flex:1;
    height:10px;
    background:#f1f5f9;
    border-radius:999px;
    overflow:hidden;
    border:1px solid var(--ring)
  }
  .bar>span{
    display:block;
    height:100%;
    background:linear-gradient(90deg,#60a5fa,#2563eb)
  }
  .pill{
    display:inline-block;
    padding:2px 8px;
    border-radius:999px;
    font-size:12px;
    border:1px solid var(--ring);
    color:#334155
  }
</style>
</head>
<body>
<header>
  <img src="https://cdn.russellxz.click/3c8ab72a.png" alt="logo"/>
  <div>
    <h1>Usuarios — Sistema de Backup SkyUltraPlus</h1>
    <div class="sub">by Russell xz</div>
  </div>
  <div style="flex:1"></div>
  <a href="/panel"><button class="secondary">Volver al Panel</button></a>
  <form method="post" action="/logout" style="margin-left:8px">
    <button class="secondary">Salir</button>
  </form>
</header>

<main>
  <!-- Consola -->
  <section class="card">
    <h2 style="margin:0 0 10px;font-size:16px">Consola — CPU / RAM / Disco</h2>
    <div class="grid cols-2">
      <div class="row">
        <label>Ruta de disco a monitorear</label>
        <input id="diskPath" value="/" placeholder="/"/>
      </div>
      <div class="row" style="align-self:end">
        <button id="btnApply">Aplicar</button>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="metric">
        <div style="width:110px">CPU</div>
        <div class="bar"><span id="cpuBar" style="width:0%"></span></div>
        <div id="cpuPct" style="width:70px;text-align:right">0%</div>
      </div>
      <div>
        <span class="pill" id="cores">Cores: -</span>
        <span class="pill" id="load">Load: -</span>
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="metric">
        <div style="width:110px">RAM</div>
        <div class="bar"><span id="ramBar" style="width:0%"></span></div>
        <div id="ramUsed" style="width:170px;text-align:right">0%</div>
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="metric">
        <div style="width:110px">Disco</div>
        <div class="bar"><span id="diskBar" style="width:0%"></span></div>
        <div id="diskUsed" style="width:70px;text-align:right">0%</div>
      </div>
      <div>
        <span class="pill" id="diskTotal">Total: -</span>
        <span class="pill" id="diskFree">Libre: -</span>
        <span class="pill" id="mountInfo">—</span>
      </div>
    </div>
  </section>

  <!-- Crear usuario -->
  <section class="card">
    <h2 style="margin:0 0 10px;font-size:16px">Crear usuario</h2>
    <div class="grid cols-2">
      <div class="row">
        <label>Correo</label>
        <input id="new_email" type="email" placeholder="nuevo@correo.com"/>
      </div>
      <div class="row">
        <label>Contraseña</label>
        <input id="new_password" type="password" placeholder="••••••••"/>
      </div>
      <div class="row">
        <label>Activo</label>
        <select id="new_active">
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>
      </div>
      <div class="row" style="align-self:end">
        <button onclick="createUser()">Crear</button>
      </div>
    </div>
    <div class="sub">Todos los usuarios tienen permisos administrativos.</div>
  </section>

  <!-- Lista -->
  <section class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0 0 10px;font-size:16px">Lista de usuarios</h2>
      <button class="secondary" onclick="loadUsers()">Refrescar</button>
    </div>
    <div id="users_wrap" class="row"></div>
  </section>
</main>

<script>
let es = null;

function connectConsole(path){
  if (es) es.close();
  const url = new URL(window.location.origin + '/api/monitor/events');
  url.searchParams.set('path', path || '/');
  es = new EventSource(url.toString());
  es.onmessage = (ev)=>{
    try {
      const j = JSON.parse(ev.data || "{}");
      // CPU
      const c = Math.max(0, Math.min(100, j.cpuPct || 0));
      document.getElementById("cpuBar").style.width = c.toFixed(1) + "%";
      document.getElementById("cpuPct").textContent = c.toFixed(1) + "%";
      document.getElementById("cores").textContent  = "Cores: " + (j.cores ?? "-");
      document.getElementById("load").textContent   = "Load: " + (j.loadAvg || []).join(", ");
      // RAM
      if (j.ram) {
        const rp = Math.max(0, Math.min(100, j.ram.usedPct || 0));
        document.getElementById("ramBar").style.width = rp.toFixed(1) + "%";
        document.getElementById("ramUsed").textContent =
          rp.toFixed(1) + "% (" + j.ram.usedHuman + " / " + j.ram.totalHuman + ")";
      }
      // Disco
      if (j.disk) {
        const used = Math.max(0, Math.min(100, j.disk.usedPct || 0));
        document.getElementById("diskBar").style.width = used.toFixed(1) + "%";
        document.getElementById("diskUsed").textContent = used.toFixed(1) + "%";
        document.getElementById("diskTotal").textContent = "Total: " + (j.disk.totalHuman || "-");
        document.getElementById("diskFree").textContent  =
          "Libre: " + (j.disk.availHuman || "-") + " (" + (j.disk.freePct || 0).toFixed(1) + "%)";
        document.getElementById("mountInfo").textContent =
          "Montaje: " + (j.disk.mount || "—") + " | FS: " + (j.disk.filesystem || "—");
      }
    } catch {}
  };
  es.onerror = ()=>{};
}

document.getElementById("btnApply").addEventListener("click", ()=>{
  connectConsole(document.getElementById("diskPath").value || "/");
});

window.addEventListener("load", ()=>{
  connectConsole(document.getElementById("diskPath").value || "/");
});

async function loadUsers(){
  const r = await fetch('/api/users');
  const j = await r.json();
  const list = j.users || [];
  const wrap = document.getElementById('users_wrap');
  if (!list.length){
    wrap.innerHTML = '<div class="sub">Sin usuarios.</div>';
    return;
  }
  let html = '<table><thead><tr><th>ID</th><th>Correo</th><th>Activo</th><th>Creado</th><th>Actualizado</th><th>Acciones</th></tr></thead><tbody>';
  html += list.map(u => \`
    <tr>
      <td>\${u.id}</td>
      <td><input id="email_\${u.id}" value="\${u.email}" style="width:100%"/></td>
      <td>
        <select id="active_\${u.id}">
          <option value="true" \${u.is_active?'selected':''}>Sí</option>
          <option value="false" \${!u.is_active?'selected':''}>No</option>
        </select>
      </td>
      <td>\${new Date(u.created_at).toLocaleString()}</td>
      <td>\${new Date(u.updated_at).toLocaleString()}</td>
      <td>
        <button onclick="save(\${u.id})">Guardar</button>
        <button class="secondary" onclick="resetPass(\${u.id})">Cambiar clave</button>
        <button style="background:#b91c1c" onclick="delUser(\${u.id})">Eliminar</button>
      </td>
    </tr>\`).join('');
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function createUser(){
  const email = document.getElementById('new_email').value.trim();
  const password = document.getElementById('new_password').value;
  const active = document.getElementById('new_active').value === 'true';
  if (!email || !password){
    alert('Correo y contraseña son requeridos');
    return;
  }
  const r = await fetch('/api/users', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password, active })
  });
  const j = await r.json();
  if (!r.ok){
    alert(j.error || 'Error al crear usuario');
    return;
  }
  document.getElementById('new_email').value='';
  document.getElementById('new_password').value='';
  document.getElementById('new_active').value='true';
  loadUsers();
}

async function save(id){
  const email  = document.getElementById('email_'+id).value.trim();
  const active = document.getElementById('active_'+id).value === 'true';
  const r = await fetch('/api/users/'+id, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, active })
  });
  const j = await r.json();
  if (!r.ok){
    alert(j.error || 'Error al guardar');
    return;
  }
  loadUsers();
}

async function resetPass(id){
  const pw = prompt('Nueva contraseña:');
  if (!pw) return;
  const r = await fetch('/api/users/'+id, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ password: pw })
  });
  const j = await r.json();
  if (!r.ok){
    alert(j.error || 'Error al cambiar contraseña');
    return;
  }
  alert('Contraseña actualizada');
  loadUsers();
}

async function delUser(id){
  if (!confirm('¿Eliminar este usuario?')) return;
  const r = await fetch('/api/users/'+id, { method:'DELETE' });
  const j = await r.json();
  if (!r.ok){
    alert(j.error || 'No se pudo eliminar');
    return;
  }
  loadUsers();
}

loadUsers();
</script>
</body>
</html>`;
}

module.exports = { createUsersRouter };
