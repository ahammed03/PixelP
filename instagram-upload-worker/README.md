# PixelP Upload Worker

This separate Worker provides the public upload page at:

```text
https://pixelp.ahammed.xyz
```

It accepts a JPEG and a shared upload secret, then stores the image in the
same R2 queue used by the scheduling Worker:

```text
queue_DDMMYYYY/YYYYMMDDTHHMMSSmmmZ-random-filename.jpg
```

The scheduling Worker remains separate and continues to run its daily Gemini,
KV, and Instagram publishing Cron.

## Deploy

From this directory:

```powershell
npx wrangler login
npx wrangler deploy
npx wrangler secret put UPLOAD_SECRET
```

The local reference file is `.env.example`. Keep any real `.env` file local;
production uses the Wrangler secret above.

Use a strong shared secret. Never place it in this file or in `wrangler.jsonc`.

The Worker accepts JPEG files up to 10 MB. The R2 bucket must have a public
read URL because the scheduling Worker passes the uploaded image URL to Meta.

Cloudflare Custom Domains create the DNS and certificate automatically when the
hostname is available in the active Cloudflare zone. If the hostname already
has a CNAME record, remove that conflicting record before deployment.
