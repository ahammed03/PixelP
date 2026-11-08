"""Latest-image Instagram publisher.

Modes:
  Windows:  python script.py --once
  Worker:   deploy as a Python Worker with the python_workers flag.

The queue object format is produced by upload_to_r2/upload_to_r2.py:
queue_DDMMYYYY/YYYYMMDDTHHMMSSffffffZ-<sha12>-filename.ext
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
KEY_PATTERN = re.compile(r"^(?P<folder>queue_\d{8})/(?P<timestamp>\d{8}T\d{12,16}Z)-(?P<hash>[a-f0-9]{12})-(?P<name>.+)$")


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


@dataclass(frozen=True)
class Config:
    r2_endpoint: str
    r2_bucket: str
    r2_access_key: str
    r2_secret_key: str
    kv_account_id: str
    kv_namespace_id: str
    kv_api_token: str
    kv_last_key: str
    public_media_base_url: str
    gemini_api_key: str
    gemini_model: str
    instagram_user_id: str
    instagram_access_token: str
    instagram_api_version: str


def config_from_env() -> Config:
    endpoint = required("ENDPOINT").rstrip("/")
    return Config(
        endpoint,
        required("R2_BUCKET"),
        required("ACCESS_KEY_ID"),
        required("SECRET_ACCESS_KEY"),
        required("CLOUDFLARE_ACCOUNT_ID"),
        required("CLOUDFLARE_KV_NAMESPACE_ID"),
        required("CLOUDFLARE_API_TOKEN"),
        os.getenv("LAST_PUBLISHED_KV_KEY", "instagram:last_published").strip(),
        required("PUBLIC_MEDIA_BASE_URL").rstrip("/"),
        required("GEMINI_API_KEY"),
        os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip(),
        required("INSTAGRAM_USER_ID"),
        required("INSTAGRAM_ACCESS_TOKEN"),
        os.getenv("INSTAGRAM_API_VERSION", "v24.0").strip(),
    )


def sign_key(secret: str, date: str) -> bytes:
    def sign(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode(), hashlib.sha256).digest()
    return sign(sign(sign(sign(("AWS4" + secret).encode(), date), "auto"), "s3"), "aws4_request")


def signed_s3_request(cfg: Config, method: str, path: str, query: str = "", body: bytes = b"", content_type: str = "application/octet-stream") -> urllib.request.Request:
    parsed = urllib.parse.urlsplit(cfg.r2_endpoint)
    host = parsed.netloc
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    headers = f"content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join([method, path, query, headers, signed, payload_hash])
    scope = f"{date}/auto/s3/aws4_request"
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signature = hmac.new(sign_key(cfg.r2_secret_key, date), string_to_sign.encode(), hashlib.sha256).hexdigest()
    auth = f"AWS4-HMAC-SHA256 Credential={cfg.r2_access_key}/{scope}, SignedHeaders={signed}, Signature={signature}"
    request = urllib.request.Request(f"{cfg.r2_endpoint}{path}?{query}" if query else f"{cfg.r2_endpoint}{path}", data=body, method=method)
    for key, value in {"Host": host, "Content-Type": content_type, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date, "Authorization": auth}.items():
        request.add_header(key, value)
    return request


def r2_path(cfg: Config, key: str) -> str:
    return f"/{urllib.parse.quote(cfg.r2_bucket, safe='')}/{urllib.parse.quote(key, safe='/')}"


def list_r2_objects(cfg: Config) -> list[str]:
    query = "list-type=2&prefix=queue_"
    request = signed_s3_request(cfg, "GET", f"/{urllib.parse.quote(cfg.r2_bucket, safe='')}", query)
    with urllib.request.urlopen(request, timeout=60) as response:
        root = ET.fromstring(response.read())
    return [element.text for element in root.iter() if element.tag.endswith("Key") and element.text]


def read_r2_object(cfg: Config, key: str) -> tuple[bytes, str]:
    request = signed_s3_request(cfg, "GET", r2_path(cfg, key))
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read(), response.headers.get_content_type()


def kv_url(cfg: Config, key: str) -> str:
    encoded = urllib.parse.quote(key, safe="")
    return f"https://api.cloudflare.com/client/v4/accounts/{cfg.kv_account_id}/storage/kv/namespaces/{cfg.kv_namespace_id}/values/{encoded}"


def kv_get(cfg: Config, key: str) -> str | None:
    request = urllib.request.Request(kv_url(cfg, key), headers={"Authorization": f"Bearer {cfg.kv_api_token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def kv_put(cfg: Config, key: str, value: str) -> None:
    request = urllib.request.Request(kv_url(cfg, key), data=value.encode(), method="PUT", headers={"Authorization": f"Bearer {cfg.kv_api_token}", "Content-Type": "text/plain"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"KV write failed: HTTP {response.status}")


def parse_key(key: str) -> tuple[datetime, str] | None:
    match = KEY_PATTERN.match(key)
    if not match:
        return None
    stamp = match.group("timestamp")
    stamp = stamp[:15] + "Z" if len(stamp) == 16 else stamp
    try:
        return datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), key
    except ValueError:
        return None


def select_latest_after(cfg: Config, last_key: str | None) -> tuple[datetime, str] | None:
    parsed = [item for key in list_r2_objects(cfg) if (item := parse_key(key))]
    parsed.sort(key=lambda item: item[0])
    if last_key:
        parsed = [item for item in parsed if item[1] != last_key and item[1] > last_key]
    return parsed[0] if parsed else None


def gemini_caption(cfg: Config, image: bytes, content_type: str) -> tuple[str, list[str]]:
    payload = {
        "contents": [{"parts": [
            {"inline_data": {"mime_type": content_type, "data": base64.b64encode(image).decode()}},
            {"text": "Return only JSON: {\\"caption\\": string, \\"hashtags\\": string[]}. Create an engaging Instagram caption and 5-10 relevant hashtags. Do not invent facts."},
        ]}],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg.gemini_model}:generateContent?key={urllib.parse.quote(cfg.gemini_api_key)}"
    request = urllib.request.Request(url, data=__import__("json").dumps(payload).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = __import__("json").loads(response.read())
    result = __import__("json").loads(data["candidates"][0]["content"]["parts"][0]["text"])
    return result["caption"].strip(), [tag if tag.startswith("#") else f"#{tag}" for tag in result["hashtags"]]


def meta_post(cfg: Config, image_key: str, caption: str, content_type: str) -> str:
    media_url = f"{cfg.public_media_base_url}/{urllib.parse.quote(image_key, safe='/')}"
    base = f"https://graph.facebook.com/{cfg.instagram_api_version}/{cfg.instagram_user_id}"
    form = urllib.parse.urlencode({"image_url": media_url, "caption": caption, "access_token": cfg.instagram_access_token}).encode()
    request = urllib.request.Request(f"{base}/media", data=form, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=60) as response:
        container_id = __import__("json").loads(response.read())["id"]
    for _ in range(12):
        time.sleep(5)
        status_request = urllib.request.Request(f"https://graph.facebook.com/{cfg.instagram_api_version}/{container_id}?fields=status_code&access_token={urllib.parse.quote(cfg.instagram_access_token)}")
        with urllib.request.urlopen(status_request, timeout=30) as response:
            status = __import__("json").loads(response.read()).get("status_code")
        if status == "FINISHED":
            break
        if status in {"ERROR", "EXPIRED"}:
            raise RuntimeError(f"Instagram container failed: {status}")
    else:
        raise RuntimeError("Instagram container did not finish in time")
    publish = urllib.parse.urlencode({"creation_id": container_id, "access_token": cfg.instagram_access_token}).encode()
    publish_request = urllib.request.Request(f"{base}/media_publish", data=publish, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(publish_request, timeout=60) as response:
        return __import__("json").loads(response.read())["id"]


def run_once(cfg: Config) -> str:
    last = kv_get(cfg, cfg.kv_last_key)
    selected = select_latest_after(cfg, last)
    if not selected:
        return "No new queued image found."
    _, key = selected
    image, content_type = read_r2_object(cfg, key)
    caption, hashtags = gemini_caption(cfg, image, content_type)
    media_id = meta_post(cfg, key, f"{caption}\n\n{' '.join(hashtags)}", content_type)
    kv_put(cfg, cfg.kv_last_key, key)
    return f"Published {key} as Instagram media {media_id}"


try:
    from workers import WorkerEntrypoint

    class Default(WorkerEntrypoint):
        async def scheduled(self, controller, env, ctx):
            # For Python Workers, expose the same secrets as environment values.
            for name in ("ENDPOINT", "R2_BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_KV_NAMESPACE_ID", "CLOUDFLARE_API_TOKEN", "PUBLIC_MEDIA_BASE_URL", "GEMINI_API_KEY", "INSTAGRAM_USER_ID", "INSTAGRAM_ACCESS_TOKEN"):
                if hasattr(env, name):
                    os.environ[name] = getattr(env, name)
            print(run_once(config_from_env()))
except ImportError:
    Default = None


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    if "--once" not in sys.argv:
        raise SystemExit("Use: python script.py --once")
    print(run_once(config_from_env()))
