# R2 image uploader

Place `.jpg`, `.jpeg`, `.png`, `.webp`, or `.svg` files in `upload_to_r2/images/` and run:

```powershell
python .\upload_to_r2\upload_to_r2.py
```

Each object is uploaded under a date folder such as `queue_08112026/`, with a UTC timestamp and SHA-256 prefix:

```text
queue_08112026/20261108T183000Z-a1b2c3d4e5f6-photo.jpg
```

To assign a future UTC posting time to all files in one batch, the date folder is derived from that timestamp:

```powershell
python .\upload_to_r2\upload_to_r2.py --scheduled-at 20261109T183000Z
```

Copy `.env.example` to `.env` inside this folder and fill in the values. The
script requires `upload_to_r2/.env` and does not read any project-root `.env`.
Required variables are `ENDPOINT`, `R2_BUCKET`, `ACCESS_KEY_ID`, and
`SECRET_ACCESS_KEY`. No KV namespace or duplicate-check configuration is
used. Each key includes a high-resolution UTC timestamp and SHA-256 prefix.

The included SVG files are upload fixtures only. For Instagram publishing,
use JPEG, PNG, or WebP files because Instagram's media requirements are more
restrictive than R2's.
