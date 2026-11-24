"""Generate and cache the five speaker voices for the local risk debate."""
import base64
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

from research.download import CACHE
from research.llm import configured_keys


VOICES = {
    "Profitability": "ash",
    "Cash Flow & Debt": "coral",
    "Industry": "sage",
    "Filing Narrative": "nova",
    "moderator": "onyx",
}


def audio_clip(agent, text, ledger: Path):
    key = configured_keys(prefer_file=True)["OPENAI_API_KEY"]
    if not key:
        return None, "Provider speech key is unavailable"
    options = {
        "model": "gpt-4o-mini-tts", "voice": VOICES[agent], "input": text,
        "instructions": "Speak naturally at a steady pace as a financial analyst in a live discussion.",
        "response_format": "mp3",
    }
    body = json.dumps(options).encode()
    cache = CACHE / "demo-speech"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (hashlib.sha256(body).hexdigest() + ".mp3")
    if path.is_file():
        return base64.b64encode(path.read_bytes()).decode(), None

    # Same conservative character estimate used by the macro voice lab.
    estimate = len(text) * .015 / 1000
    used = sum(json.loads(line)["reserved_usd"] for line in ledger.read_text().splitlines()) if ledger.exists() else 0
    cap = float(os.environ.get("RISK_DEMO_SPEECH_BUDGET", ".45"))
    if used + estimate > cap:
        return None, "Provider speech budget reached"
    with ledger.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"clip": path.stem, "reserved_usd": estimate,
                                 "at": time.time()}) + "\n")
    try:
        with urlopen(Request("https://api.openai.com/v1/audio/speech", data=body, headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        }), timeout=25) as stream:
            audio = stream.read()
    except (URLError, TimeoutError) as exc:
        code = getattr(exc, "code", None)
        return None, f"Provider speech unavailable{f' (HTTP {code})' if code else ''}"
    path.write_bytes(audio)
    return base64.b64encode(audio).decode(), None
