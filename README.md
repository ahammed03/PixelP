# PixelP

PixelP is a lightweight Instagram Creator auto-publishing pipeline built around Cloudflare R2, Cloudflare Workers, Workers KV, Gemini, and the Meta Instagram API.

## How it works

```text
Windows uploader → Cloudflare R2 queue_DDMMYYYY/...
                 → Cron wakes the Python Worker
                 → Worker selects the next image after the KV checkpoint
                 → Gemini creates caption and hashtags
                 → Meta publishes the Instagram post
                 → KV stores the last published R2 object key
```

The Cron Trigger only starts the Worker. Publishing runs inside the Worker’s `scheduled()` handler.

## Project folders

```text
upload_to_r2/
  upload_to_r2.py       Uploads local images to R2
  .env.example          Uploader configuration template
  images/               Local-only images; ignored by Git

cloudflare_worker/
  script.py             Windows runner and Python Worker entrypoint
  .env.example          Worker configuration template
```

Secrets and image files are intentionally excluded from Git.

## Upload images to R2

Create `upload_to_r2/.env` from the example file:

```env
ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=pixelp
ACCESS_KEY_ID=<r2-access-key>
SECRET_ACCESS_KEY=<r2-secret-key>
```

Place `.jpg`, `.jpeg`, `.png`, or `.webp` files in `upload_to_r2/images/`, then run:

```powershell
python .\upload_to_r2\upload_to_r2.py
```

Objects use a date folder and unique UTC timestamp/hash key:

```text
queue_08112026/20261108T134512123456Z-a1b2c3d4e5f6-photo.jpg
```

To assign a future UTC schedule to a batch:

```powershell
python .\upload_to_r2\upload_to_r2.py --scheduled-at 20261109T183000Z
```

The uploader does not perform duplicate checking. Every run uploads the selected files.

## Configure the Worker

Create `cloudflare_worker/.env` from its example file and provide:

```env
ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=pixelp
ACCESS_KEY_ID=<r2-access-key>
SECRET_ACCESS_KEY=<r2-secret-key>
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_KV_NAMESPACE_ID=<kv-namespace-id>
CLOUDFLARE_API_TOKEN=<token-with-kv-read-write>
LAST_PUBLISHED_KV_KEY=instagram:last_published
PUBLIC_MEDIA_BASE_URL=https://your-worker.example.com/media
GEMINI_API_KEY=<gemini-api-key>
GEMINI_MODEL=gemini-2.5-flash-lite
INSTAGRAM_USER_ID=<instagram-professional-account-id>
INSTAGRAM_ACCESS_TOKEN=<instagram-access-token>
INSTAGRAM_API_VERSION=v24.0
```

`PUBLIC_MEDIA_BASE_URL` must return the selected R2 image without authentication so Meta can fetch it.

## Run locally on Windows

```powershell
python .\cloudflare_worker\script.py --once
```

The runner selects the first queued object after the key stored in KV, asks Gemini for content, publishes through Meta, and updates KV only after successful publication.

## Cloudflare Python Worker

Point Wrangler at `cloudflare_worker/script.py`, enable the `python_workers` compatibility flag, configure the values above as Worker secrets, and add a Cron Trigger:

```text
* * * * *
```

Cron runs in UTC. The Worker checks the timestamp embedded in each R2 object key and processes the next unpublished image.

## Instagram requirements

The connected account must be an Instagram Professional account, such as Creator or Business. Meta publishing uses a media-container flow: create the container, wait for processing, then call `media_publish`.

## Security

- Never commit `.env` files, access tokens, or API keys.
- Use separate development and production credentials.
- Rotate credentials that are accidentally exposed.
