# PixelP Instagram Publisher

PixelP uploads JPEG images to Cloudflare R2, then a Cloudflare Worker uses
Gemini to generate a caption and publishes the next image to an Instagram
Professional account through Meta's Instagram API.

```text
local uploader -> R2 queue -> daily Worker Cron
                         -> Gemini caption
                         -> Instagram media container
                         -> Instagram publish
                         -> KV checkpoint
```

## Repository layout

```text
upload_to_r2/
  upload_to_r2.py       Local R2 uploader
  .env.example          Local uploader configuration template
  images/               Local images; ignored by Git

cloudflare_worker/
  src/index.js          Cloudflare Worker
  wrangler.jsonc        R2, KV, variables, and Cron configuration
  README.md             Worker deployment and operations guide
```

The old Python Worker runner has been removed. Python remains only in the
local R2 uploader.

## Prerequisites

- Cloudflare R2 bucket named `pixelp`.
- A public R2 development URL for that bucket.
- A Cloudflare KV namespace for the publishing checkpoint.
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
- An Instagram Business or Creator account with Meta publishing access.
- Node.js, `npx`, and Python for the local uploader.

## 1. Configure the local uploader

Copy `upload_to_r2/.env.example` to `upload_to_r2/.env` and fill in:

```env
ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=pixelp
ACCESS_KEY_ID=<r2-access-key>
SECRET_ACCESS_KEY=<r2-secret-key>
```

Put JPEG files in `upload_to_r2/images/` and upload them:

```powershell
python .\upload_to_r2\upload_to_r2.py
```

Use JPEG files for Instagram. The Worker ignores SVG and other unsupported
queue objects.

## 2. Configure the Worker

`cloudflare_worker/wrangler.jsonc` contains the non-secret R2, KV, public URL,
Gemini model, Instagram API version, and Cron settings. Cron uses UTC;
`30 12 * * *` means once daily at 6:00 PM India Standard Time.

Do not put API keys or access tokens in `wrangler.jsonc`.

## 3. Authenticate and deploy

```powershell
cd .\cloudflare_worker
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

Deploy again after changing Worker code or configuration:

```powershell
npx wrangler deploy
```

To run the Worker immediately instead of waiting for Cron, call its protected
trigger endpoint with the trigger secret:

```powershell
$headers = @{ Authorization = "Bearer <trigger-secret>" }
Invoke-WebRequest `
  -Uri "https://<worker-subdomain>.workers.dev/trigger" `
  -Method Post `
  -Headers $headers
```

The trigger runs the same Gemini, R2, KV, and Instagram flow as Cron.

## 4. Runtime flow

The scheduled Worker selects the first JPEG after the key stored in KV,
downloads it from R2, asks Gemini for JSON caption data, creates an Instagram
media container, waits for processing, publishes it, and updates KV only after
successful publication.

## 5. Health check

Open the deployed Worker URL. It should return:

```text
PixelP Instagram publisher is running.
```

## Security

- Never commit `.env`, `.dev.vars`, API keys, access tokens, or R2 secrets.
- Use Wrangler secrets for Worker credentials.
- Keep the R2 public URL limited to media objects.
- Rotate any credential that has been exposed.
