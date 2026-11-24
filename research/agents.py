"""Zero-shot arm orchestration with shared E/D first-round answers."""
from collections import Counter
import re


LENSES = {
    "Profitability": "margins, earnings, and deterioration in operating performance",
    "Cash Flow & Debt": "liquidity, cash generation, debt and interest service",
    "Industry": "sector benchmarks and competitive pressures",
    "Filing Narrative": "disclosed risks and management commentary",
}

TASK = (
    "Estimate the probability that the next four fiscal quarters show loss onset, "
    "a fall below half of positive trailing operating cash flow, or a common "
    "dividend cut of at least 25%. Use only the anonymised packet, cite evidence "
    "IDs for every claim, and never use outside knowledge to identify the company."
)
NUMBERS = re.compile(r"(?<![\w#])[-−+]?\d[\d,]*(?:\.\d+)?%?(?![\w#])")
FACT_ID = re.compile(r"^[FT]\d+$")


def _numbers(text):
    return [token.replace(",", "").replace("−", "-") for token in NUMBERS.findall(text)]


def check_claim(claim, evidence):
    ids = [key.removeprefix("[").removesuffix("]") for key in claim["ids"]]
    if not ids:
        return "unverifiable"
    if any(not FACT_ID.fullmatch(key) or key not in evidence for key in ids):
        return "contradicted"
    latest = re.search(r"\b(?:last|latest|most recent) (?:reported )?quarter\b",
                       claim["text"], flags=re.I)
    older = [key for key in ids if evidence[key].startswith("Q-")]
    has_latest = any(evidence[key].startswith("Q0:") for key in ids)
    if latest and older and not has_latest:
        return "contradicted"
    quoted = _numbers(re.sub(r"\[[FT]\d+\]", "", claim["text"]))
    observed = [_numbers(evidence[key]) for key in ids]
    observed = [value for group in observed for value in group]
    for token in quoted:
        digits = token.rstrip("%")
        decimals = len(digits.partition(".")[2])
        tolerance = 0.5 * 10 ** -decimals
        if not any(value.endswith("%") == token.endswith("%") and
                   abs(float(value.rstrip("%")) - float(digits)) <= tolerance
                   for value in observed):
            return "contradicted"
    return "supported"


def risk_label(p):
    if not 0 <= p <= 1:
        raise ValueError(f"Invalid risk probability: {p}")
    return "High" if p >= .5 else "Medium" if p >= .2 else "Low"


SPEAKING = (
    "This is spoken dialogue for a room of students who have never taken finance. "
    "Sound like yourself talking to a classmate. Lead with what matters, then give "
    "one concrete number and explain what it means. Aim for 25–45 words in 2–3 short "
    "sentences. Use everyday replacements such as 'bills due soon', 'cash the business "
    "brings in', and 'profit on each dollar of sales'. Keep names of accounting ratios "
    "and codes out of say. Use money units such as $3.5 billion and at most three "
    "significant figures. State your chance of trouble and risk level naturally, "
    "without a stock closing line. Below 20% is low, below 50% is medium, otherwise high. "
    "Q0 is the latest report; Q-7 is the oldest. Say 'last reported quarter' or "
    "'about two years ago'. Do not compare the sum of four quarters to one quarter "
    "as evidence of growth. Keep 1–3 exact claims with evidence IDs in claims, "
    "apart from say. Do not put evidence IDs, analogies, or finance jargon in say."
)


def repeated_rebuttal(first, second, peers):
    opening = Counter(re.findall(r"\b\w+\b", first["say"].casefold()))
    rebuttal = Counter(re.findall(r"\b\w+\b", second["say"].casefold()))
    return (
        second["responds_to"] not in peers or not rebuttal
        or sum((opening & rebuttal).values()) / sum(rebuttal.values()) > .5
    )


def briefing(answer):
    return {"risk_percent": answer["p"] * 100, "claims": answer["claims"]}


def run_arms(call, numeric, narrative, *, debate_only=False, on_turn=None, on_bridge=None):
    """Run shared research calls. Optional callbacks expose accepted debate turns."""
    if not narrative:
        raise ValueError("Filing Narrative needs real excerpts from the latest eligible filing.")
    full = {**numeric, **narrative}
    task = TASK + " " + SPEAKING
    out = {}
    if not debate_only:
        out["B"] = call("B", "single", 1, task, {"evidence": numeric})
        out["C"] = call("C", "single", 1, task, {"evidence": full})
    first = {}
    for role, lens in LENSES.items():
        instructions = f"You are {role}. Focus on {lens}. {task} Follow the word and claim limits strictly."
        if role == "Filing Narrative":
            instructions += (
                " Focus your spoken line on one thing management said in its filing. "
                "Start with 'Management says' or 'The filing warns'. Ground the first scored "
                "claim in that same T excerpt. Do not lead with financial ratios."
            )
        first[role] = call("E/D", role, 1, instructions, {"evidence": full})
        if on_turn:
            on_turn(role, 1, first[role])
    e_p = sum(answer["p"] for answer in first.values()) / len(first)
    checks = {role: [check_claim(claim, full) for claim in answer["claims"]]
              for role, answer in first.items()}
    if on_bridge:
        on_bridge(first)

    second, retried, flagged = {}, [], []
    for role in first:
        peers = {other: answer for other, answer in first.items() if other != role}
        target = max(peers, key=lambda other: abs(peers[other]["p"] - first[role]["p"]))
        context = {"evidence": full, "own_view": briefing(first[role]),
                   "other_views": {other: briefing(answer) for other, answer in peers.items()},
                   "referee_checks": checks, "respond_to": target, "speaker": role}
        instructions = (
            task + f" You are {role}, speaking in rebuttal. Name exactly one other role "
            "in responds_to and address that colleague by name in say. Answer their specific "
            "point with evidence, then explain what changed or why your probability stayed put. "
            f"Your assigned colleague is {target}. Set responds_to to {target} and start say by addressing that colleague. "
            "Change only if someone points out evidence you missed or misread. "
            "Use different wording and reasoning from your opening."
        )
        answer = call("D", role, 2, instructions, context)
        if repeated_rebuttal(first[role], answer, peers):
            retried.append(role)
            answer = call("D", role, 2,
                          instructions + " You repeated yourself. Respond to a colleague by name.",
                          {**context, "rejected_rebuttal": True})
            if repeated_rebuttal(first[role], answer, peers):
                flagged.append(role)
        second[role] = answer
        if on_turn:
            on_turn(role, 2, answer)
    d = call("D", "moderator", 3,
             TASK + " You are the moderator speaking to a class without finance training. "
             "Start with where two analysts agree or differ. Name the argument that "
             "tipped your vote and explain why it mattered more than its counterargument. "
             "Give the final percent and risk level and say what someone watching the "
             "company should look for next. Use four short spoken sentences, everyday "
             "words, and no recital of figures. Keep exact cited drivers in claims.",
             {"evidence": full,
              "opening_votes": {role: briefing(answer) for role, answer in first.items()},
              "final_votes": {role: briefing(answer) for role, answer in second.items()},
              "referee_checks": checks})
    if on_turn:
        on_turn("moderator", 3, d)
    out.update(E={"p": e_p}, D=d)
    for arm in out.values():
        arm["label"] = risk_label(arm["p"])
    return {"arms": out, "round_one": first, "round_two": second, "referee": checks,
            "rebuttal_retries": retried, "rebuttal_flags": flagged}
