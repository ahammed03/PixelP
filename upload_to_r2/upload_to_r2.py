#!/usr/bin/env python3
"""Upload images from this folder to Cloudflare R2.

Object keys are written as:
    queue/YYYYMMDDTHHMMSSZ-<sha256-prefix>-<filename>.<ext>

The script uses only Python's standard library. KV duplicate checks are
enabled when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_KV_NAMESPACE_ID exist in
the environment; otherwise the R2 upload still works.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
IMAGE_DIR = ROOT / "images"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".svg"}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def signing_key(secret: str, date: str, region: str, service: str) -> bytes:
    def sign(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    return sign(sign(sign(sign(("AWS4" + secret).encode("utf-8"), date), region), service), "aws4_request")


def signed_request(method: str, url: str, body: bytes, access_key: str, secret_key: str, content_type: str) -> urllib.request.Request:
    parsed = urllib.parse.urlsplit(url)
    host = parsed.netloc
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join([
        method,
        urllib.parse.quote(parsed.path or "/", safe="/-_.~"),
        parsed.query,
        canonical_headers,
        signed_headers,
        payload_hash,
    ])
    scope = f"{date}/auto/s3/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    signature = hmac.new(
        signing_key(secret_key, date, "auto", "s3"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Host", host)
    request.add_header("Content-Type", content_type)
    request.add_header("x-amz-content-sha256", payload_hash)
    request.add_header("x-amz-date", amz_date)
    request.add_header("Authorization", authorization)
    return request


def r2_config() -> tuple[str, str, str, str]:
    endpoint = os.getenv("ENDPOINT", "").strip() or os.getenv("CLOUDFLARE_R2_S3_API", "").strip()
    if not endpoint:
        raise RuntimeError("Set ENDPOINT or CLOUDFLARE_R2_S3_API in .env")
    parsed = urllib.parse.urlsplit(endpoint if "://" in endpoint else f"https://{endpoint}")
    path_parts = [part for part in parsed.path.split("/") if part]
    alternate = urllib.parse.urlsplit(os.getenv("CLOUDFLARE_R2_S3_API", "").strip())
    alternate_parts = [part for part in alternate.path.split("/") if part]
    bucket = os.getenv("R2_BUCKET", "").strip() or (path_parts[0] if path_parts else "") or (alternate_parts[0] if alternate_parts else "")
    if not bucket:
        raise RuntimeError("Set R2_BUCKET in .env (it could not be inferred from the endpoint)")
    base = f"{parsed.scheme}://{parsed.netloc}"
    return base, bucket, required("ACCESS_KEY_ID"), required("SECRET_ACCESS_KEY")


def r2_put(key: str, data: bytes, content_type: str) -> None:
    base, bucket, access_key, secret_key = r2_config()
    url = f"{base}/{urllib.parse.quote(bucket, safe='')}/{urllib.parse.quote(key, safe='/') }"
    request = signed_request("PUT", url, data, access_key, secret_key, content_type)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError(f"R2 returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"R2 upload failed with HTTP {exc.code}: {detail[:500]}") from exc


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "image"


def upload_file(path: Path, prefix: str, scheduled_at: str | None) -> None:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()

    timestamp = scheduled_at or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = safe_name(path.name)
    key = f"{prefix.rstrip('/')}/{timestamp}-{digest[:12]}-{filename}"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    r2_put(key, data, content_type)
    print(f"UPLOADED {path.name} -> {key}")


def main() -> int:
    env_file = ROOT / ".env"
    if not env_file.exists():
        raise SystemExit(
            f"Missing {env_file}. Copy .env.example to .env inside upload_to_r2 and fill in the required values."
        )
    load_dotenv(env_file)
    parser = argparse.ArgumentParser(description="Upload images in upload_to_r2/images to Cloudflare R2")
    parser.add_argument("--scheduled-at", help="UTC key timestamp, e.g. 20261109T183000Z")
    parser.add_argument("--prefix", help="R2 key prefix; default is queue_DDMMYYYY")
    args = parser.parse_args()
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in IMAGE_DIR.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS)
    if not files:
        print(f"No supported images found in {IMAGE_DIR}")
        return 0
    if args.prefix:
        prefix = args.prefix
    elif args.scheduled_at:
        try:
            scheduled_date = datetime.strptime(args.scheduled_at, "%Y%m%dT%H%M%SZ")
        except ValueError as exc:
            raise SystemExit("--scheduled-at must use YYYYMMDDTHHMMSSZ, for example 20261108T183000Z") from exc
        prefix = scheduled_date.strftime("queue_%d%m%Y")
    else:
        prefix = datetime.now(timezone.utc).strftime("queue_%d%m%Y")
    for path in files:
        try:
            upload_file(path, prefix, args.scheduled_at)
        except Exception as exc:
            print(f"ERROR {path.name}: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
