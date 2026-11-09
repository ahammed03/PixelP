const GRAPH_BASE = "https://graph.facebook.com";

function required(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new Error(`Missing ${name}`);
  return String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function mediaUrl(base, key) {
  return `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function listImageKeys(bucket) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: "queue_", limit: 1000, cursor });
    for (const object of page.objects) {
      if (/\.(jpe?g)$/i.test(object.key)) keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

async function generateCaption(env, image, contentType) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const prompt = [
    "Return only valid JSON in this exact shape:",
    '{"caption":"string","hashtags":["#tag1","#tag2"]}',
    "Create an engaging Instagram caption and 5-10 relevant hashtags. Do not invent facts."
  ].join(" ");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(required(env, "GEMINI_API_KEY"))}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: contentType || "image/jpeg", data: image } },
          { text: prompt }
        ] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );
  const data = await responseJson(response, "Gemini");
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no caption text");
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim());
  const hashtags = (parsed.hashtags || []).map((tag) => String(tag).startsWith("#") ? String(tag) : `#${tag}`);
  return `${String(parsed.caption || "").trim()}\n\n${hashtags.join(" ")}`.trim();
}

async function publishToInstagram(env, imageUrl, caption) {
  const version = env.INSTAGRAM_API_VERSION || "v24.0";
  const base = `${GRAPH_BASE}/${version}/${required(env, "INSTAGRAM_USER_ID")}`;
  const token = required(env, "INSTAGRAM_ACCESS_TOKEN");

  const create = await fetch(`${base}/media`, {
    method: "POST",
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token })
  });
  const { id: containerId } = await responseJson(create, "Instagram media container");

  let finished = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(5000);
    const status = await fetch(`${GRAPH_BASE}/${version}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    const data = await responseJson(status, "Instagram container status");
    if (data.status_code === "FINISHED") {
      finished = true;
      break;
    }
    if (["ERROR", "EXPIRED"].includes(data.status_code)) throw new Error(`Instagram container status: ${data.status_code}`);
  }
  if (!finished) throw new Error("Instagram container did not finish within 60 seconds");

  const publish = await fetch(`${base}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: containerId, access_token: token })
  });
  return (await responseJson(publish, "Instagram publish")).id;
}

async function publishNext(env) {
  if (String(env.PUBLISH_ENABLED).toLowerCase() !== "true") {
    return "Publishing disabled. Set PUBLISH_ENABLED=true after configuring KV tracking.";
  }
  const keys = await listImageKeys(env.PIXELP_BUCKET);
  const lastKey = env.PIXELP_KV ? await env.PIXELP_KV.get(env.LAST_PUBLISHED_KV_KEY || "instagram:last_published") : null;
  const key = keys.find((candidate) => !lastKey || candidate > lastKey);
  if (!key) return "No new queued JPEG found.";

  const object = await env.PIXELP_BUCKET.get(key);
  if (!object) throw new Error(`R2 object not found: ${key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const image = btoa(binary);
  const caption = await generateCaption(env, image, object.httpMetadata?.contentType || "image/jpeg");
  const publicUrl = mediaUrl(required(env, "PUBLIC_MEDIA_BASE_URL"), key);
  const mediaId = await publishToInstagram(env, publicUrl, caption);
  if (env.PIXELP_KV) await env.PIXELP_KV.put(env.LAST_PUBLISHED_KV_KEY || "instagram:last_published", key);
  return `Published ${key} as Instagram media ${mediaId}`;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(publishNext(env).then(console.log).catch((error) => console.error(error.stack || error)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger" && request.method === "POST") {
      const expected = required(env, "PUBLISH_TRIGGER_SECRET");
      const provided = request.headers.get("authorization") || "";
      if (provided !== `Bearer ${expected}`) return new Response("Unauthorized", { status: 401 });
      try {
        return new Response(await publishNext(env), { status: 200 });
      } catch (error) {
        console.error(error.stack || error);
        return new Response(String(error.message || error), { status: 500 });
      }
    }
    return new Response("PixelP Instagram publisher is running.", { status: 200 });
  }
};
