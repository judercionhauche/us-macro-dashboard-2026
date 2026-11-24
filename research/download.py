"""Public research inputs with a disk cache and SEC request pacing."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


CACHE = Path(os.environ.get("RISK_CACHE_DIR", Path.home() / ".cache" / "sp500-risk"))
SEC_AGENT = os.environ.get("RISK_SEC_USER_AGENT", "SP500 Risk Study Research")
_sec_lock = threading.Lock()
_sec_next = 0.0


def _pace_sec_requests():
    global _sec_next
    with _sec_lock:
        time.sleep(max(0, _sec_next - time.monotonic()))
        _sec_next = time.monotonic() + 0.125


def get(url: str, *, timeout: float = 20, retries: int = 2) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()

    host = urlparse(url).hostname or ""
    is_sec = host == "sec.gov" or host.endswith(".sec.gov")
    headers = {"User-Agent": SEC_AGENT if is_sec else "sp500-risk research"}
    for attempt in range(retries + 1):
        if is_sec:
            _pace_sec_requests()
        try:
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                body = response.read()
        except HTTPError as exc:
            if attempt == retries or (exc.code != 429 and exc.code < 500):
                raise
        except (TimeoutError, URLError):
            if attempt == retries:
                raise
        else:
            with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as stream:
                stream.write(body)
            os.replace(stream.name, path)
            return body
        time.sleep(0.6 * 2 ** attempt)
    raise RuntimeError(f"Download failed: {url}")


def sec_json(url: str) -> dict:
    return json.loads(get(url))


def submissions(cik: int) -> dict:
    return sec_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")


def companyfacts(cik: int) -> dict:
    return sec_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
