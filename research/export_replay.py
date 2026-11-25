"""Export the two verified AEP debates as a static, read-only Pages bundle."""
import argparse
import base64
import json
from pathlib import Path
from shutil import copyfile

import pandas as pd
from research.risk_study import write_benchmark, write_study


ROOT = Path(__file__).resolve().parent.parent


def export(output, recordings, public_api=None):
    output.mkdir(parents=True, exist_ok=True)
    traces = {}
    for mode, path in recordings.items():
        events = [json.loads(line) for line in path.read_text().splitlines() if line]
        assert events[0]["type"] == "start" and events[-1]["type"] == "result"
        assert events[-1]["mode"] == mode
        assert all(count == 3 for count in events[-1]["result"]["turn_counts"].values())
        folder = output / "replay" / mode
        folder.mkdir(parents=True, exist_ok=True)
        for i, event in enumerate(events):
            audio = event.pop("audio", None)
            if event["type"] in {"turn", "narration"}:
                if not audio:
                    raise ValueError(f"{mode} is missing audio for turn {i}")
                name = f"{i:02d}.mp3"
                (folder / name).write_bytes(base64.b64decode(audio, validate=True))
                event["audio_url"] = f"replay/{mode}/{name}"
            if event["type"] == "turn":
                event.pop("evidence", None)
            # Keep audit IDs and descriptions. The filing link carries the original passages.
            for call in event.get("tool_calls", []):
                if call["tool"] == "search_filing":
                    call["result"]["value"] = None
        (folder / "events.jsonl").write_text(
            "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events))
        traces[mode] = events
    sample = pd.read_csv(ROOT / "results/sample.csv")
    labels = pd.read_csv(ROOT / "results/labels.csv")
    # Pin the selectors and initial chart to the verified historical recording.
    start = traces["demo"][0]
    history = [dict(row, cik=4904) for row in start["history"]]
    historical_label = labels[(labels["cik"] == 4904) & (labels["cutoff"] == start["cutoff"])]
    history.append(dict(history[-1], cutoff=start["cutoff"],
                        positive=int(historical_label.iloc[0]["positive"])))
    data = {"sample":sample[sample["cik"]==4904].to_dict("records"),"history":history,
            "recordings": {mode: {key: events[0][key] for key in ("cutoff", "history")}
                           for mode, events in traces.items()},
            "company_count":len(sample),"total":len(labels),"positive":int(labels["positive"].sum()),
            "metrics":json.loads((ROOT/"results/preliminary_baselines.json").read_text())}
    (output/"replay/study.json").write_text(json.dumps(data, allow_nan=False))
    write_study(output / "results/risk_study.json")
    write_benchmark(output / "results/risk_benchmark.json")
    html = (ROOT/"index.html").read_text()
    if public_api:
        from html import escape
        html = html.replace('<html lang="en">', f'<html lang="en" data-risk-api="{escape(public_api, quote=True)}">')
        html = html.replace('</nav>', '<a href="?watch=recording">Watch the recording</a></nav>', 1)
    else:
        html = html.replace('<html lang="en">', '<html lang="en" data-debate="replay">')
    html = html.replace('<a href="?view=macro" id="macroViewLink">','<a href="../" id="macroViewLink">')
    html = html.replace('<a href="?view=risk" id="riskViewLink">','<a href="./" id="riskViewLink">')
    if not public_api:
        html = html.replace('Listen as four analysts debate the company’s SEC financials, cast their votes, and hand the final decision to a moderator.',
                        'Watch the recorded AEP debate with the original voices, tool results, and deciding vote.')
        html = html.replace('<h2>Watch a live debate</h2>','<h2>Watch the AEP debate</h2>')
        html = html.replace('Today · latest filings','Today demo · November 24, 2026')
        html = html.replace("Start voice debate", "Play voice debate")
    if not public_api:
        html = html.replace('<label>Company <select', '<label hidden>Company <select')
        html = html.replace('<label>Cutoff <select', '<label hidden>Cutoff <select')
    badge = "Live Risk Lab" if public_api else "Recorded demo"
    html = html.replace('<span class="pill">Updated <strong id="updatedLabel">—</strong></span>',
                        f'<span class="pill">{badge}</span>')
    before, remaining = html.split('    <div id="macroDashboard">', 1)
    html = before + '    <div id="macroDashboard" hidden></div>\n' + remaining[remaining.index("    <footer"):]
    for script in ("app.js","lab.js","voice-debate.js","marked.min.js"):
        html = html.replace(f'  <script src="{script}"></script>\n', "")
    html = html.replace('<span id="yearNow"></span>', '2026')
    (output/"index.html").write_text(html)
    for path in ("risk.js","styles.css","chart.umd.js","results/figures/fig2.png",
                 "results/human_benchmark/ratings_vs_ai.png"):
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        copyfile(ROOT/path, target)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--historical",type=Path,required=True)
    parser.add_argument("--today",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--public-api", help="HTTPS base URL of the Worker Risk API")
    args=parser.parse_args()
    export(args.output,{"demo":args.historical,"today":args.today},args.public_api)
