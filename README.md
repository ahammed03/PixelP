# PixelP Instagram Automation

PixelP uses two separate Cloudflare Workers:

```text
pixelp.ahammed.xyz                 -> browser upload Worker -> R2 queue
pixelp-instagram-publisher Worker  -> Gemini -> Instagram -> KV checkpoint
```

## Repository layout

```text
instagram-publisher-worker/
  src/index.js          Scheduled Gemini + Instagram publisher
  wrangler.jsonc        R2, KV, secrets, and Cron configuration
  .env.example          Local variable reference; no secrets
  README.md             Publisher deployment guide

instagram-upload-worker/
  src/index.js          Public JPEG upload UI and API
  wrangler.jsonc        R2 binding and custom domain configuration
  .env.example          Upload secret reference; no secrets
  README.md             Upload Worker deployment guide
```

The old Python Worker and the `upload_to_r2` folder are not tracked in Git.
Local copies of `upload_to_r2` are ignored for users who still want batch
uploads, but the supported upload path is the browser Worker.

## Prerequisites

- Active Cloudflare zone for `ahammed.xyz`.
- R2 bucket named `pixelp` with a public read URL.
- KV namespace attached to the publisher Worker.
- Instagram Business or Creator account with Meta publishing access.
- Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
- Node.js and `npx`.

## 1. Deploy the upload Worker

```powershell
cd .\instagram-upload-worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put UPLOAD_SECRET
```

Open:

```text
https://pixelp.ahammed.xyz
```

The page accepts JPEG files up to 10 MB and writes timestamped keys such as:

```text
queue_09112026/20261109T100220817Z-a1b2c3d4e5f6-photo.jpg
```

## 2. Deploy the publisher Worker

```powershell
cd ..\instagram-publisher-worker
npx wrangler deploy
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_USER_ID
npx wrangler secret put PUBLISH_TRIGGER_SECRET
```

The publisher Cron is `30 12 * * *`, which means 6:00 PM IST because Cloudflare
Cron uses UTC. It selects the next JPEG after the key stored in KV, asks Gemini
for a caption, publishes through Meta, and updates KV after success.

## 3. Trigger the publisher immediately

```powershell
$headers = @{ Authorization = "Bearer <trigger-secret>" }
Invoke-WebRequest `
  -Uri "https://<publisher-subdomain>.workers.dev/trigger" `
  -Method Post `
  -Headers $headers
```

## Security

- Never commit `.env`, API keys, access tokens, R2 credentials, or shared
  secrets.
- Use `npx wrangler secret put ...` for production secrets.
- Keep `PUBLISH_TRIGGER_SECRET` and `UPLOAD_SECRET` different.
- The upload secret is shared access, not per-user authentication.
- Rotate any credential that has been exposed.
