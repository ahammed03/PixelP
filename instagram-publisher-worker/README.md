# PixelP Cloudflare Worker

This directory contains the JavaScript Worker that publishes Instagram posts.
It is the only publishing runtime in this repository; the old Python Worker
runner has been removed.

Browser uploads are handled by the separate `instagram-upload-worker`; this
Worker does not expose the upload UI.

## What the Worker does

1. Lists JPEG objects under the `queue_` prefix in R2.
2. Reads the last published object key from KV.
3. Downloads the next image from R2 and builds its public R2 URL.
4. Sends the image to Gemini for a caption and hashtags.
5. Creates an Instagram media container.
6. Waits for Meta to finish processing the container.
7. Publishes the container and writes the key to KV.

The default Cron is `30 12 * * *`, which is 6:00 PM IST because Cloudflare
Cron expressions use UTC.

## Deploy

From this directory:

```powershell
npx wrangler login
npx wrangler deploy
```

Store credentials as encrypted Wrangler secrets:

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_USER_ID
npx wrangler secret put PUBLISH_TRIGGER_SECRET
```

Never add secret values to `wrangler.jsonc`, source files, or README files.

For an immediate test, call the protected trigger endpoint:

```powershell
$headers = @{ Authorization = "Bearer <trigger-secret>" }
Invoke-WebRequest `
  -Uri "https://<worker-subdomain>.workers.dev/trigger" `
  -Method Post `
  -Headers $headers
```

The endpoint runs the same Gemini, R2, KV, and Instagram flow as Cron. Keep
`PUBLISH_TRIGGER_SECRET` private.

## Required configuration

`wrangler.jsonc` contains only non-secret configuration:

- `PIXELP_BUCKET`: R2 bucket binding.
- `PIXELP_KV`: KV namespace binding.
- `PUBLIC_MEDIA_BASE_URL`: public R2 development URL.
- `GEMINI_MODEL`: Gemini model name.
- `INSTAGRAM_API_VERSION`: Graph API version.
- `PUBLISH_ENABLED`: production publish switch.

The Worker requires these secrets:

```text
GEMINI_API_KEY
INSTAGRAM_ACCESS_TOKEN
INSTAGRAM_USER_ID
```

## Upload source

Use the separate upload Worker at `https://pixelp.ahammed.xyz`. It writes
timestamped JPEG keys to the same R2 bucket used by this publisher.

## Health check

Open the deployed Worker URL in a browser. It should return:

```text
PixelP Instagram publisher is running.
```

## Troubleshooting

- `No new queued JPEG found`: upload a JPEG to R2 or inspect the KV checkpoint.
- Gemini errors: verify `GEMINI_API_KEY` and `GEMINI_MODEL`.
- Instagram errors: verify the Professional account, user ID, token, and
  public R2 URL.
- Duplicate protection: confirm the `PIXELP_KV` binding exists and
  `PUBLISH_ENABLED` is `true`.
