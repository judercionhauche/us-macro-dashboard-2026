"""Structured-output experiment client with an append-only spending ledger."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CLAIMS = {"type": "array", "items": {"type": "object", "additionalProperties": False,
           "properties": {"text": {"type": "string"},
                          "ids": {"type": "array", "items": {"type": "string"}}},
           "required": ["text", "ids"]}}
PROPERTIES = {"speaker": {"type": "string"}, "say": {"type": "string"},
              "risk_percent": {"type": "number"},
              "stance": {"type": "string", "enum": ["low", "medium", "high"]},
              "responds_to": {"type": "string"}, "claims": CLAIMS,
              "would_change_my_mind": {"type": "string"}, "open_disagreements": {"type": "string"}}
SCHEMA = {"type": "object", "additionalProperties": False,
          "properties": PROPERTIES, "required": list(PROPERTIES)}
TOOL = {"name": "record_risk", "description": "Record the evidence-based risk assessment.",
        "parameters": SCHEMA}


def configured_keys(*, prefer_file=False):
    keys = {name: os.environ.get(name) for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY")}
    env_file = Path("worker/.dev.vars")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() in keys and (prefer_file or not keys[name.strip()]):
                keys[name.strip()] = value.strip().strip("'\"") or keys[name.strip()]
    return keys


class CallFailed(RuntimeError):
    pass


class BudgetExceeded(RuntimeError):
    pass


class Client:
    def __init__(self, ledger, cap=40.0, *, prefer_file=False):
        keys = configured_keys(prefer_file=prefer_file)
        self.openai = bool(keys["OPENAI_API_KEY"])
        self.key = keys["OPENAI_API_KEY"] or keys["ANTHROPIC_API_KEY"]
        if not self.key:
            raise ValueError("A research provider API key is required")
        self.model, self.input_rate, self.output_rate = (
            ("gpt-4o-mini", .15, .60) if self.openai else ("claude-haiku-5-5", .10, .50)
        )
        self.ledger = Path(ledger)
        if not 0 < cap <= 40:
            raise ValueError("Research spending cap must be positive and at most $40")
        self.cap = cap
        self.run_lock = self.ledger.with_suffix(".lock").open("a", encoding="utf-8")
        try:
            fcntl.flock(self.run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.run_lock.close()
            raise BudgetExceeded("Another process already holds the research spending ledger")
        self.lock = threading.Lock()
        self.cache = {}
        self.spent = 0.0
        self.reservations = {}
        if self.ledger.exists():
            for line in self.ledger.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                key = rec["attempt_id"]
                if rec["status"] == "reserved":
                    self.reservations[key] = rec["reserved_usd"]
                else:
                    self.reservations.pop(key, None)
                    self.spent += rec["cost_usd"]
                    if rec["status"] == "success":
                        self.cache[rec["prompt_hash"]] = rec["response"]

    def log(self, rec):
        with self.ledger.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(rec, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def request(self, system, context, length, tool=TOOL):
        user = json.dumps(context, ensure_ascii=False)
        if tool is TOOL:
            system += (
            " Call record_risk. Use an empty string for responds_to outside rebuttals and other inapplicable text fields."
        )
        if self.openai:
            return "https://api.openai.com/v1/chat/completions", {
                "Authorization": f"Bearer {self.key}",
            }, {
                "model": self.model, "temperature": 0.2, "max_tokens": length,
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}],
                "tools": [{"type": "function", "function": {**tool, "strict": True}}],
                "tool_choice": {"type": "function", "function": {"name": tool["name"]}},
            }
        return "https://api.anthropic.com/v1/messages", {
            "x-api-key": self.key, "anthropic-version": "2023-06-01",
        }, {
            "model": self.model, "temperature": 0.2, "max_tokens": length, "system": system,
            "messages": [{"role": "user", "content": user}],
            "tools": [{"name": tool["name"], "description": tool["description"],
                       "input_schema": tool["parameters"]}],
            "tool_choice": {"type": "tool", "name": tool["name"]},
        }

    def __call__(self, arm, agent, round, system, context, *, tool=TOOL):
        length = 900 if agent == "moderator" else 700
        url, headers, options = self.request(system, context, length, tool)
        body = json.dumps(options, ensure_ascii=False, sort_keys=True).encode()
        prompt_hash = hashlib.sha256(body).hexdigest()
        with self.lock:
            if prompt_hash in self.cache:
                return self.cache[prompt_hash].copy()
        ceiling = ((len(body) + 1024) * self.input_rate + length * self.output_rate) / 1e6
        for attempt in range(3):
            attempt_id = f"{prompt_hash}:{time.time_ns()}"
            log = dict(arm=arm, agent=agent, round=round, prompt_hash=prompt_hash,
                       model=self.model, attempt_id=attempt_id)
            with self.lock:
                if self.spent + sum(self.reservations.values()) + ceiling > self.cap:
                    raise BudgetExceeded("Research spending cap reached")
                self.log({**log, "status": "reserved", "reserved_usd": ceiling})
                self.reservations[attempt_id] = ceiling
            started = time.monotonic()
            cost = ceiling
            input_tokens = output_tokens = None
            try:
                with urlopen(Request(url, data=body, headers={
                    **headers, "Content-Type": "application/json",
                }), timeout=45) as stream:
                    result = json.load(stream)
                usage = result["usage"]
                if self.openai:
                    input_tokens, output_tokens = usage["prompt_tokens"], usage["completion_tokens"]
                else:
                    input_tokens, output_tokens = usage["input_tokens"], usage["output_tokens"]
                cost = (input_tokens * self.input_rate + output_tokens * self.output_rate) / 1e6
                if self.openai:
                    response = json.loads(result["choices"][0]["message"]["tool_calls"][0]
                                          ["function"]["arguments"])
                else:
                    response = next(block["input"] for block in result["content"]
                                    if block["type"] == "tool_use" and block["name"] == tool["name"])
                if tool is TOOL:
                    response["p"] = response["risk_percent"] / 100
                    p = response["p"]
                    response["stance"] = "high" if p >= .5 else "medium" if p >= .2 else "low"
                    if not 0 <= p <= 1 or not isinstance(response["claims"], list) or not response["say"].strip():
                        raise ValueError("Invalid risk response")
                status = "success"
            except (HTTPError, URLError, TimeoutError, ValueError, KeyError, IndexError,
                    StopIteration, TypeError) as exc:
                if isinstance(exc, HTTPError) and exc.code < 500:
                    cost = 0.0
                status, response = "failed", {"error": type(exc).__name__}
                if isinstance(exc, HTTPError):
                    response["http_status"] = exc.code
            with self.lock:
                self.log({**log, "status": status, "response": response, "cost_usd": cost,
                          "tokens_in": input_tokens, "tokens_out": output_tokens,
                          "latency_s": time.monotonic() - started})
                self.reservations.pop(attempt_id)
                self.spent += cost
                if status == "success":
                    self.cache[prompt_hash] = response
                    return response.copy()
            if response.get("http_status") == 401:
                provider = "OpenAI" if self.openai else "Anthropic"
                variable = "OPENAI_API_KEY" if self.openai else "ANTHROPIC_API_KEY"
                raise CallFailed(f"{provider} rejected the configured key (HTTP 401). "
                                 f"Update {variable} in worker/.dev.vars or the server environment.")
            if attempt < 2:
                time.sleep(.6 * 2 ** attempt)
        raise CallFailed(f"{arm}/{agent} round {round} failed after three attempts")
