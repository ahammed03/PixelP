function required(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new Error(`Missing ${name}`);
  return String(value).trim();
}

function uploadPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PixelP Upload</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;background:#f6f7fb;color:#172033}main{background:white;padding:28px;border-radius:16px;box-shadow:0 8px 30px #17203318}label{display:block;margin:18px 0 8px;font-weight:600}input,button{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccd2df;border-radius:8px;font-size:16px}button{margin-top:22px;background:#315efb;color:white;border:0;cursor:pointer}button:disabled{opacity:.6}#result{margin-top:18px;white-space:pre-wrap}</style>
</head><body><main><h1>Upload to PixelP</h1><p>Upload a JPEG to the Instagram publishing queue.</p>
<form id="form"><label for="image">JPEG image</label><input id="image" name="image" type="file" accept="image/jpeg,.jpg,.jpeg" required>
<label for="secret">Upload secret</label><input id="secret" name="secret" type="password" autocomplete="current-password" required>
<button id="button" type="submit">Upload image</button></form><div id="result"></div></main>
<script>const form=document.querySelector('#form'),button=document.querySelector('#button'),result=document.querySelector('#result');form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;result.textContent='Uploading...';try{const response=await fetch('/upload',{method:'POST',body:new FormData(form)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Upload failed');result.textContent='Uploaded successfully.\\n'+data.key}catch(error){result.textContent=error.message}finally{button.disabled=false}});</script>
</body></html>`;
}

function utcQueueKey(filename) {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const stamp = `${date}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`;
  const safeName = filename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload.jpg";
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `queue_${date.slice(4)}/${stamp}-${random}-${safeName}`;
}

async function uploadImage(request, env) {
  const form = await request.formData();
  const providedSecret = String(form.get("secret") || "");
  if (!providedSecret || providedSecret !== required(env, "UPLOAD_SECRET")) {
    return new Response(JSON.stringify({ error: "Invalid upload secret" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const image = form.get("image");
  if (!image || typeof image.arrayBuffer !== "function") {
    return new Response(JSON.stringify({ error: "A JPEG image is required" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (image.type !== "image/jpeg" || image.size > 10 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "Only JPEG images up to 10 MB are accepted" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const key = utcQueueKey(image.name || "upload.jpg");
  await env.PIXELP_BUCKET.put(key, await image.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
  return new Response(JSON.stringify({ ok: true, key }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(uploadPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        return await uploadImage(request, env);
      } catch (error) {
        console.error(error.stack || error);
        return new Response(JSON.stringify({ error: "Upload failed" }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("Not found", { status: 404 });
  }
};
