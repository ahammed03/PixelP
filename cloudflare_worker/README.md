# Cloudflare Instagram publisher

`script.py` selects the first queued R2 image after the last key stored in KV,
sends the image to Gemini for a caption and hashtags, publishes it through
Meta's Instagram API, then stores the published R2 key in KV.

## Windows

Copy `.env.example` to `.env`, fill in the values, then run:

```powershell
python .\script.py --once
```

## Cloudflare Python Worker

Python Workers support the `python_workers` compatibility flag. Point Wrangler's
`main` at `script.py`, configure the same names as Worker secrets, and add a
Cron Trigger. The trigger only invokes the `scheduled()` handler; publishing
logic stays in `run_once()`.

The public media route must return the R2 object without authentication so Meta
can fetch the image. `PUBLIC_MEDIA_BASE_URL` should point to that route.
