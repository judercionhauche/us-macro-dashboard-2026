"""Balanced live panel with a separate function call for tool selection."""
from research.agents import LENSES, SPEAKING, TASK, check_claim, risk_label
from research.live_tools import DESCRIPTION, FEATURES, MONEY


ARGUMENTS = {"name":{"type":"string","enum":list(DESCRIPTION)},
             "metric":{"type":"string","enum":["", *sorted(MONEY), *FEATURES]},
             "quarters_back":{"type":"integer"}, "question":{"type":"string"}}
SELECT = {"name":"request_analysis", "description":"Request one to three pieces of evidence",
          "parameters":{"type":"object","additionalProperties":False,
                        "properties":{"requests":{"type":"array","items":{
                            "type":"object","additionalProperties":False,
                            "properties":ARGUMENTS,"required":list(ARGUMENTS)}}},
                        "required":["requests"]}}


ROLE_OPENING_TOOLS = {
    "Profitability": ("get_trend",),
    "Cash Flow & Debt": ("forecast", "distress_score"),
    "Industry": ("compare_to_peers",),
    "Filing Narrative": ("search_filing", "filing_tone"),
}


def grounded_turn(call, tools, arm, role, round_number, instruction, context):
    required = ROLE_OPENING_TOOLS.get(role, ()) if round_number == 1 else ()
    peer_metrics = [metric for metric in FEATURES if metric in tools.peers]
    data = {"tools":DESCRIPTION, "available_peer_metrics": peer_metrics,
            "required_tools":list(required), **context}
    selection = ("Choose one to three analysis requests suited to your task. Call request_analysis. "
                 "Include every required tool exactly once. Forecast accepts operating_cash_flow or revenue. "
                 "For compare_to_peers choose only from available_peer_metrics. "
                 "Use empty arguments for unused fields. " + instruction)
    plan = call(arm, role, round_number, selection, data, tool=SELECT)
    requests = plan["requests"][:3]
    if not set(required) <= {item["name"] for item in requests}:
        plan = call(arm, role, round_number,
                    selection + " The previous selection omitted required tools.", data, tool=SELECT)
        requests = plan["requests"][:3]
    if not requests or not set(required) <= {item["name"] for item in requests}:
        raise ValueError(f"{role} did not request the required analysis")
    start = len(tools.log)
    evidence = [tools.ask(**item) for item in requests[:3]]
    prompt = (TASK + " " + SPEAKING.replace("25–45 words in 2–3 short sentences", "60–70 words in 4–5 short sentences") + " "
              "Every factual number must be copied from your analysis results, with the same units. "
              "The only separate number is your judgment, risk_percent. Do not calculate numbers. "
              + instruction)
    data = {**context, "analysis_results":evidence}
    answer = call(arm, role, round_number, prompt, data)
    count = len(answer["say"].split())
    if count > 90 or (role in LENSES and count < 50):
        correction = " Too long, cut to 80 words." if count > 90 else (
            " Too short. Explain the one point clearly in 50 to 80 words."
        )
        answer = call(arm, role, round_number, prompt + correction, data)
    return answer, tools.log[start:]


def live_panel(call, tools, announce, speak):
    roles = list(LENSES)
    turn_count = dict.fromkeys(roles, 0)
    words = dict.fromkeys(roles, 0)
    rounds = []
    for index, purpose in enumerate(("opening", "rebuttal", "vote"), 1):
        answers = {}
        order = roles[index-1:] + roles[:index-1]
        for role in order:
            previous = rounds[-1] if rounds else {}
            target = (max((peer for peer in previous if peer != role),
                          key=lambda peer: abs(previous[peer]["p"] - previous[role]["p"]))
                      if previous else None)
            context = {}
            instruction = f"You are {role}, focused on {LENSES[role]}. Give your {purpose}."
            if target:
                assert turn_count[role] == min(turn_count.values())
                context = {"colleague":target,"their_claims":previous[target]["claims"],
                           "their_risk_percent":previous[target]["risk_percent"],
                           "your_previous_risk_percent":previous[role]["risk_percent"]}
                announce(role, purpose, context)
                instruction += (f" Address {target} and answer one specific point. "
                                "Say why your vote stays the same or changes.")
            answer, calls = grounded_turn(call, tools, "live", role, index, instruction, context)
            answers[role] = answer
            turn_count[role] += 1
            words[role] += len(answer["say"].split())
            speak(role, index, answer, calls)
        rounds.append(answers)
    first, rebuttal, final = rounds
    verdict, calls = grounded_turn(
        call, tools, "live", "moderator", 4,
        "Deliver the deciding verdict in plain words. Summarize where the panel differed, "
        "which argument changed your mind and why, your risk vote and what to watch next.",
        {"votes":{role:{"risk_percent":a["risk_percent"], "claims":a["claims"]}
                  for role, a in final.items()}})
    speak("moderator", 4, verdict, calls)
    verdict["label"] = risk_label(verdict["p"])
    return {"arms":{"E":{"p":sum(a["p"] for a in first.values()) / 4}, "D":verdict},
            "round_one":first,"round_two":final,"rebuttals":rebuttal,
            "referee":{role:[check_claim(claim,tools.evidence) for claim in answer["claims"]]
                       for role, answer in first.items()},"turn_counts":turn_count,"word_counts":words}


def grounded_research(call, tools):
    """Candidate research protocol. Both single-agent controls get the same tool menu."""
    singles = {}
    for arm, instruction in (
        ("B", "Start with the company's financial metrics."),
        ("C", "Start with a management disclosure when one is useful."),
    ):
        singles[arm], _ = grounded_turn(
            call, tools, arm, "single", 1, "Independently assess this company's risk. " + instruction, {},
        )
        singles[arm]["label"] = risk_label(singles[arm]["p"])
    outcome = live_panel(call, tools, announce=lambda *args:None, speak=lambda *args:None)
    outcome["arms"].update(singles)
    outcome["tool_evidence"] = tools.evidence
    outcome["tool_calls"] = tools.log
    return outcome
