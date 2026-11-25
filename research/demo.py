"""Local-only server for the S&P 500 research dashboard and live demonstration."""
from datetime import date, datetime
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
import hmac
import os
import re
import subprocess
from tempfile import NamedTemporaryFile
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlsplit

import pandas as pd

from research.agents import check_claim
from research.live_debate import live_panel
from research.live_tools import AnalysisTools
from research.features import ratios
from research.filings import filing_history
from research.packets import dollar_scale
from research.demo_story import narrative_evidence, outcome_facts, present
from research.demo_voice import audio_clip
from research.download import CACHE, companyfacts
from research.llm import Client
from research.panel import build_quarters
from research.risk_study import study_payload


ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
STATE = Lock()


def speech_reserved():
    ledger = RESULTS / "demo_speech_calls.jsonl"
    return sum(json.loads(line)["reserved_usd"] for line in ledger.read_text().splitlines()) if ledger.exists() else 0


def clip_seconds(audio, spoken):
    if audio:
        try:
            with NamedTemporaryFile(suffix=".mp3") as clip:
                clip.write(base64.b64decode(audio))
                clip.flush()
                info = subprocess.check_output(["afinfo", clip.name], text=True, timeout=3)
                match = re.search(r"estimated duration: ([0-9.]+)", info)
                if match:
                    return float(match[1])
        except (OSError, subprocess.SubprocessError):
            pass
    return len(spoken.split()) / 2.5


def demo_facts(cik):
    facts = companyfacts(cik)
    source = CACHE / "issuer-facts" / f"{cik}.json"
    if source.exists():
        gaap = facts["facts"]["us-gaap"]
        for item in json.loads(source.read_text()):
            tag = item.pop("tag")
            gaap.setdefault(tag, {"units":{}})["units"].setdefault("USD", []).append(item)
    return facts


def gauge_history(facts, cutoff):
    quarters = build_quarters(facts, cutoff)
    out = []
    for i, (end, _) in enumerate(quarters.items()):
        if end.year < 2018:
            continue
        values = ratios(list(quarters.values())[:i+1])
        out.append({"cutoff":end.isoformat(), **{k:float(values[k]) if pd.notna(values[k]) else None
                    for k in ("net_margin","debt_assets","ocf_margin")}})
    return out


class Dashboard(BaseHTTPRequestHandler):
    def payload(self, value, status=200):
        body = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def relay_authorized(self):
        value = os.environ.get("RISK_RELAY_SECRET")
        return bool(value and hmac.compare_digest(self.headers.get("X-Risk-Relay", ""), value))

    def do_GET(self):
        request = urlsplit(self.path)
        if os.environ.get("RISK_RELAY_ONLY") == "1" and not self.relay_authorized():
            self.payload({"error":"Unauthorized live model relay."}, 403)
            return
        if request.path == "/" and not request.query:
            self.send_response(302)
            self.send_header("Location", "/?view=risk")
            self.end_headers()
            return
        assets = {"/": ("index.html", "text/html"),
                  "/styles.css": ("styles.css", "text/css"),
                  "/results/risk_study.json": ("results/risk_study.json", "application/json"),
                  "/results/risk_benchmark.json": ("results/risk_benchmark.json", "application/json"),
                  "/results/human_benchmark/ratings_vs_ai.png": ("results/human_benchmark/ratings_vs_ai.png", "image/png"),
                  "/results/figures/fig2.png": ("results/figures/fig2.png", "image/png")}
        for script in ("app.js", "lab.js", "voice-debate.js", "risk.js",
                       "marked.min.js", "chart.umd.js"):
            assets["/" + script] = script, "text/javascript"
        if request.path in assets:
            path, mime = assets[request.path]
            body = (ROOT / path).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif request.path == "/api/current-history":
            try:
                cik = int(parse_qs(request.query)["cik"][0])
                sample = pd.read_csv(RESULTS / "sample.csv")
                if cik not in set(sample["cik"]):
                    raise ValueError("Company is outside the research sample")
                today = datetime.now(ZoneInfo("America/New_York")).date()
                self.payload(gauge_history(demo_facts(cik), today))
            except (OSError, ValueError, KeyError):
                self.payload({"error":"Latest numeric history is unavailable."}, 404)
        elif self.path == "/api/study":
            self.payload(study_payload())
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/api/debate":
            self.send_error(404)
            return
        if not STATE.acquire(blocking=False):
            self.payload({"error": "A live debate is already running."}, 409)
            return
        streaming = False
        client = None
        try:
            # Require a same-origin custom header before initiating any paid call.
            local = self.headers.get("X-Risk-Demo") == "local"
            relay_only = os.environ.get("RISK_RELAY_ONLY") == "1"
            if not self.relay_authorized() and (relay_only or not local):
                self.payload({"error": "Open the local dashboard to start the debate."}, 403)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                raise ValueError("Invalid debate request.")
            request = json.loads(self.rfile.read(size))
            cik = int(request["cik"])
            mode = request.get("mode", "research")
            if mode not in {"research", "demo", "today"}:
                raise ValueError("Choose Research, Historical demo, or Today.")
            today = datetime.now(ZoneInfo("America/New_York")).date()
            cutoff = today if mode == "today" else date.fromisoformat(request["cutoff"])
            if mode != "today" and not date(2018,12,31) <= cutoff <= date(2024,12,31):
                raise ValueError("Historical dates run from 2018 through 2024.")
            panel = pd.read_csv(RESULTS / "panel.csv")
            sample = pd.read_csv(RESULTS / "sample.csv")
            selected = sample[sample["cik"] == cik]
            if selected.empty:
                raise ValueError("Choose a company in the research sample.")
            ticker, sector = selected.iloc[0][["ticker", "sector"]]
            facts = demo_facts(cik)
            name = facts["entityName"]
            quarters = build_quarters(facts, cutoff)
            if not quarters:
                raise ValueError("No quarterly data was available at this cutoff.")
            peers = panel[(panel["sector"] == sector) & (panel["cutoff"] == cutoff.isoformat())]
            if mode == "today":
                peers = pd.DataFrame([ratios(list(build_quarters(companyfacts(int(peer)), cutoff).values()))
                    for peer in sample[sample["sector"] == sector]["cik"]])
            filing_url = None
            filings = []
            for reference in (cutoff, date(cutoff.year-1, cutoff.month, min(cutoff.day,28) if cutoff.month == 2 else cutoff.day)):
                try:
                    narrative, url = narrative_evidence(cik, ticker, name, reference, mode)
                    if reference == cutoff:
                        filing_url = url
                    filing = [f for f in filing_history(cik, date(reference.year-1,1,1))
                              if f["form"] in {"10-K","10-Q"} and f["filingDate"] <= reference.isoformat()][-1]
                    filings.append((date.fromisoformat(filing["filingDate"]), tuple(narrative.values())))
                except (OSError, ValueError):
                    if reference == cutoff:
                        break
            tools = AnalysisTools(quarters, cutoff, peers.to_dict("list"), filings,
                                  dollar_scale(cik) if mode == "research" else 1)
            timeline = gauge_history(facts, today)
            client = Client(RESULTS / "demo_llm_calls.jsonl", cap=1.0, prefer_file=True)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            streaming = True
            self.emit({"type":"start","evidence":{}, "model":client.model,
                       "mode":mode,"filing_url":filing_url,
                       "cutoff":cutoff.isoformat(),
                       "history":gauge_history(facts, cutoff)})
            transcript = [f"# {name} ({ticker}) — {cutoff.isoformat()}",
                          f"Mode: {mode}. Model: {client.model}."]
            if filing_url:
                transcript.append(f"Filing source: {filing_url}")

            speech_start = speech_reserved()
            speech_time = {}
            llm_start = client.spent

            def say(agent, spoken, *, round_number=0, response=None, title=None, calls=()):
                audio, audio_error = audio_clip(agent, spoken, RESULTS / "demo_speech_calls.jsonl")
                event = dict(type="turn" if response else "narration", agent=agent,
                             round=round_number, spoken=spoken, audio=audio,
                             audio_error=audio_error, title=title)
                speech_time[agent] = speech_time.get(agent, 0) + clip_seconds(audio, spoken)
                if response:
                    event["tool_calls"] = calls
                    event["evidence"] = tools.evidence
                    event["response"] = response
                    heading = f"{agent} · Round {round_number} · {response['p']:.0%}"
                    if response["responds_to"]:
                        heading += f" · responds to {response['responds_to']}"
                    citations = sorted({key for claim in response["claims"] for key in claim["ids"]})
                    verdicts = [check_claim(claim, tools.evidence) for claim in response["claims"]]
                    transcript.extend([f"## {heading}", spoken, "Evidence: " + ", ".join(citations),
                                       "Claim checks: " + ", ".join(verdicts)])
                    for item in calls:
                        arguments = {key:item[key] for key in ("metric","quarters_back","question")}
                        transcript.append(f"- {item['tool']} {json.dumps(arguments)}: "
                                          f"{json.dumps(item['result'], ensure_ascii=False)}")
                else:
                    transcript.extend([f"## {title}", spoken])
                self.emit(event)

            def observed_call(arm, agent, round, system, context, **kwargs):
                return client(f"{mode}/{arm}", agent, round, system, context, **kwargs)

            def host(title, instruction, data, slots=None):
                say("moderator", present(observed_call, title, instruction, data, slots), title=title)

            identity = ({"company":name,"industry":sector,"as_of":cutoff.strftime("%B %d, %Y")}
                        if mode != "research" else {"company":"an anonymous S&P 500 company"})
            host("Welcome", "Open in under 70 words. Introduce the company and, if provided, "
                 "its industry and the date of the information. Ask if it could face trouble "
                 "in the next year. Explain all three kinds of trouble in everyday words. "
                 "Introduce the four roles and say that the moderator will make the final call.",
                 {**identity,"risk_events":["full-year loss","cash from running the business falls by half",
                                           "company cuts its payout to shareholders"],
                  "roles":["Profitability","Cash Flow & Debt","Industry","Filing Narrative"]})
            host("Meet the analysts", "Introduce these four analysts by name. Give one short "
                 "line each explaining what they look at. Use the exact role labels and do not invent personal names. Use under 45 words in total.", {
                     "Profitability": "whether the company makes money",
                     "Cash Flow & Debt": "cash coming in and bills coming due",
                     "Industry": "what similar businesses look like",
                     "Filing Narrative": "what management says in its latest report",
                 })
            outcome = live_panel(
                observed_call, tools,
                announce=lambda role, phase, context: host(
                    "Over to " + role, "Ask the assigned speaker one direct question about "
                    "the stated disagreement, then give them the floor. Keep it short.",
                    {"speaker":role,"phase":phase,**context}),
                speak=lambda role, round, answer, calls: say(
                    role, answer["say"], round_number=round, response=answer, calls=calls),
            )
            if mode == "demo":
                host("What happened next", "Reveal the observed result in one everyday sentence. "
                     "An empty events list means none of the defined events happened. "
                     "If verified is false, say the outcome is unavailable.",
                     outcome_facts(RESULTS / "labels.csv", cik, cutoff))
            elif mode == "today":
                host("Looking ahead", "In one sentence tell the audience that this is a "
                     "forward-looking judgment and the outcome is still unknown.", {})
            outcome["speech_seconds"] = speech_time
            outcome["cost_usd"] = client.spent - llm_start + speech_reserved() - speech_start
            transcript.append("## Speaking time")
            for role, count in outcome["turn_counts"].items():
                transcript.append(f"- {role}: {count} turns, {outcome['word_counts'][role]} words, "
                                  f"{speech_time.get(role, 0):.1f} seconds.")
            transcript.append(f"- Moderator and host: {speech_time.get('moderator',0):.1f} seconds.")
            transcript.append(f"Estimated API spend for this session: ${outcome['cost_usd']:.4f}.")
            if mode != "research":
                path = RESULTS / ("demo_today.md" if mode == "today" else "demo_historical.md")
                path.write_text("\n\n".join(transcript) + "\n")
            observed = ([row for row in timeline if cutoff.isoformat() < row["cutoff"] <=
                         (pd.Timestamp(cutoff) + pd.DateOffset(years=1)).date().isoformat()]
                        if mode == "demo" else [])
            self.emit({"type":"result","result":outcome,"mode":mode,"observed":observed})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            reason = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__
            if streaming:
                self.emit({"type": "error", "error": reason})
            else:
                self.payload({"error": reason}, 400)
        finally:
            if client is not None:
                client.run_lock.close()
            STATE.release()

    def emit(self, event):
        self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
        self.wfile.flush()


if __name__ == "__main__":
    port = int(os.environ.get("RISK_DEMO_PORT", "8790"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Dashboard)
    print(f"S&P 500 Risk Lab at http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
