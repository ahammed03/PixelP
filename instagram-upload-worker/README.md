# PixelP Upload Worker

This separate Worker provides the public upload page at:

```text
https://pixelp.ahammed.xyz
```

It provides a D1-backed login dashboard. Authenticated users can upload JPEGs,
preview queued images, paginate five at a time, and delete published images.
Files are stored in the same R2 queue used by the scheduling Worker:

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
npx wrangler d1 migrations apply pixelp --remote
```

The local reference file is `.env.example`. Keep any real `.env` file local;
production authentication uses the remote D1 database binding.

Users and password hashes are stored in D1; no separate upload secret is used.

The Worker accepts JPEG files up to 10 MB and limits total active storage to
1 GB by default. The R2 bucket must have a public read URL because the
scheduling Worker passes the uploaded image URL to Meta.

Cloudflare Custom Domains create the DNS and certificate automatically when the
hostname is available in the active Cloudflare zone. If the hostname already
has a CNAME record, remove that conflicting record before deployment.
