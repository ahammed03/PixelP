const SESSION_COOKIE = "pp_session";
const LAST_PUBLISHED_KEY = "instagram:last_published";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function b64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256(value) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function passwordHash(password, salt, iterations = 100000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(salt), iterations, hash: "SHA-256" }, key, 256);
  return `${iterations}.${salt}.${b64(new Uint8Array(bits))}`;
}

function cookie(request, name) {
  const part = (request.headers.get("cookie") || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

async function isAuthenticated(request, env) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token || !env.PIXELP_DB) return false;
  const row = await env.PIXELP_DB.prepare("SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(token), Date.now()).first();
  return Boolean(row);
}

async function newSession(env, username) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await env.PIXELP_DB.prepare("INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), username, Date.now() + 604800000).run();
  return token;
}

function queueKey(filename) {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const stamp = `${date}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`;
  const safe = filename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload.jpg";
  return `queue_${date.slice(4)}/${stamp}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}-${safe}`;
}

function mediaUrl(env, key) {
  return `${env.PUBLIC_MEDIA_BASE_URL.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function syncQueue(env) {
  const last = env.PIXELP_KV ? await env.PIXELP_KV.get(LAST_PUBLISHED_KEY) : null;
  const page = await env.PIXELP_BUCKET.list({ prefix: "queue_", limit: 1000 });
  for (const object of page.objects.filter((item) => /\.(jpe?g)$/i.test(item.key))) {
    const status = last && object.key <= last ? "published" : "queued";
    await env.PIXELP_DB.prepare(`INSERT INTO uploads (r2_key, filename, size_bytes, uploaded_at, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET size_bytes=excluded.size_bytes, status=CASE WHEN uploads.status='deleted' THEN 'deleted' ELSE excluded.status END`).bind(object.key, object.key.split("/").pop(), object.size || 0, object.uploaded?.toISOString() || new Date().toISOString(), status).run();
  }
}

function loginPage() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PixelP Login</title><style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:20px;background:#f6f7fb}main{background:#fff;padding:28px;border-radius:16px}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:12px;border-radius:8px;border:1px solid #ccd2df;font-size:16px}button{background:#315efb;color:#fff;border:0}</style></head><body><main><h1>PixelP</h1><p>Sign in to manage the Instagram queue.</p><form method="post" action="/login"><input name="username" placeholder="Username" autocomplete="username" required><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><button>Sign in</button></form></main></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PixelP Dashboard</title><style>body{font-family:system-ui;max-width:1000px;margin:28px auto;padding:0 18px;background:#f6f7fb;color:#172033}header{display:flex;justify-content:space-between;align-items:center}button,input{padding:10px;border:1px solid #ccd2df;border-radius:8px;font-size:15px}button{cursor:pointer}.primary{background:#315efb;color:#fff;border:0}.danger{background:#b42318;color:#fff;border:0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px;margin-top:20px}.card{background:#fff;border-radius:12px;padding:12px}.card img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}.published{color:#16803c;font-weight:600}.queued{color:#b54708;font-weight:600}.controls{display:flex;gap:10px;align-items:center;margin-top:20px}</style></head><body><header><h1>PixelP Queue</h1><button id="logout">Log out</button></header><form id="upload"><input name="image" type="file" accept="image/jpeg,.jpg,.jpeg" required><button class="primary">Upload JPEG</button></form><p id="message"></p><div id="grid" class="grid"></div><div class="controls"><button id="previous">Previous</button><span id="page"></span><button id="next">Next</button></div><script>let current=1,total=1;const grid=document.querySelector('#grid'),message=document.querySelector('#message');async function load(page=1){const response=await fetch('/api/images?page='+page);if(response.status===401){location.reload();return}const data=await response.json();current=data.page;total=data.pages;document.querySelector('#page').textContent='Page '+current+' of '+total;grid.innerHTML=data.items.map(item=>'<article class="card"><img src="'+item.url+'" alt="'+item.filename+'"><p>'+item.filename+'</p><p class="'+item.status+'">'+item.status+'</p><p>'+item.size_mb+' MB</p>'+(item.status==='published'?'<button class="danger" data-key="'+encodeURIComponent(item.r2_key)+'">Delete published</button>':'')+'</article>').join('');grid.querySelectorAll('[data-key]').forEach(button=>button.onclick=async()=>{if(!confirm('Delete this published image?'))return;const result=await fetch('/api/delete',{method:'POST',body:new URLSearchParams({key:decodeURIComponent(button.dataset.key)})});message.textContent=(await result.json()).message||'Delete failed';load(current)});document.querySelector('#previous').disabled=current<=1;document.querySelector('#next').disabled=current>=total}document.querySelector('#upload').onsubmit=async event=>{event.preventDefault();const result=await fetch('/api/upload',{method:'POST',body:new FormData(event.target)});const data=await result.json();message.textContent=data.message||data.error||'Done';if(result.ok){event.target.reset();load(1)}};document.querySelector('#logout').onclick=async()=>{await fetch('/logout',{method:'POST'});location.reload()};document.querySelector('#previous').onclick=()=>load(current-1);document.querySelector('#next').onclick=()=>load(current+1);load();</script></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(await isAuthenticated(request, env) ? dashboardPage() : loginPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (request.method === "POST" && url.pathname === "/login") {
      const form = await request.formData();
      const username = String(form.get("username") || "").trim();
      const password = String(form.get("password") || "");
      const user = await env.PIXELP_DB.prepare("SELECT username, password_hash FROM users WHERE username = ?").bind(username).first();
      let valid = false;
      if (user) {
        const [iterations, salt, expected] = user.password_hash.split(".");
        valid = (await passwordHash(password, salt, Number(iterations))).split(".").pop() === expected;
      }
      if (!valid) return new Response("Invalid username or password", { status: 401 });
      const token = await newSession(env, username);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` } });
    }
    if (request.method === "POST" && url.pathname === "/logout") {
      const token = cookie(request, SESSION_COOKIE);
      if (token) await env.PIXELP_DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return new Response(null, { status: 204, headers: { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` } });
    }
    if (!(await isAuthenticated(request, env))) return json({ error: "Unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/api/upload") {
      const form = await request.formData();
      const image = form.get("image");
      const maxUpload = Number(env.MAX_UPLOAD_BYTES || 10485760);
      if (!image || typeof image.arrayBuffer !== "function" || image.type !== "image/jpeg") return json({ error: "Only JPEG images are accepted" }, 400);
      if (image.size > maxUpload) return json({ error: "Image exceeds the upload limit" }, 413);
      const maxStorage = Number(env.MAX_STORAGE_BYTES || 1073741824);
      const used = await env.PIXELP_DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM uploads WHERE status != 'deleted'").first();
      if (Number(used.bytes) + image.size > maxStorage) return json({ error: "Storage cap reached; delete published images first" }, 413);
      const key = queueKey(image.name || "upload.jpg");
      await env.PIXELP_BUCKET.put(key, await image.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
      await env.PIXELP_DB.prepare("INSERT INTO uploads (r2_key, filename, size_bytes, uploaded_at, status) VALUES (?, ?, ?, ?, 'queued')").bind(key, key.split("/").pop(), image.size, new Date().toISOString()).run();
      return json({ message: "Image uploaded successfully", key });
    }
    if (request.method === "GET" && url.pathname === "/api/images") {
      await syncQueue(env);
      const perPage = 5;
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const count = await env.PIXELP_DB.prepare("SELECT COUNT(*) AS count FROM uploads WHERE status != 'deleted'").first();
      const pages = Math.max(1, Math.ceil(Number(count.count) / perPage));
      const current = Math.min(page, pages);
      const rows = await env.PIXELP_DB.prepare("SELECT r2_key, filename, size_bytes, status, uploaded_at FROM uploads WHERE status != 'deleted' ORDER BY uploaded_at ASC LIMIT ? OFFSET ?").bind(perPage, (current - 1) * perPage).all();
      return json({ page: current, pages, items: rows.results.map((row) => ({ ...row, url: mediaUrl(env, row.r2_key), size_mb: (Number(row.size_bytes) / 1048576).toFixed(2) })) });
    }
    if (request.method === "POST" && url.pathname === "/api/delete") {
      const form = await request.formData();
      const key = String(form.get("key") || "");
      const row = await env.PIXELP_DB.prepare("SELECT status FROM uploads WHERE r2_key = ?").bind(key).first();
      if (!row || row.status !== "published") return json({ error: "Only published images can be deleted" }, 400);
      await env.PIXELP_BUCKET.delete(key);
      await env.PIXELP_DB.prepare("UPDATE uploads SET status='deleted', deleted_at=? WHERE r2_key=?").bind(new Date().toISOString(), key).run();
      return json({ message: "Published image deleted" });
    }
    return new Response("Not found", { status: 404 });
  }
};
