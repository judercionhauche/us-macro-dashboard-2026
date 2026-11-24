import unittest

from research.agents import LENSES, check_claim, run_arms
from research.demo_voice import VOICES


class DebateTests(unittest.TestCase):
    def test_rebuttal_retry_keeps_separate_speech_and_scored_claims(self):
        seen = []

        def call(arm, role, round_number, instruction, context):
            seen.append((role, round_number, context))
            opening = "The company has enough cash to pay current bills."
            peer = next(iter(context.get("other_views", {})), "")
            say = opening if round_number != 2 or "rejected_rebuttal" not in context else (
                f"{peer}, your concern about financing overlooks a credit line. My estimate remains low."
            )
            return {"p": .15, "say": say, "responds_to": peer,
                    "claims": [{"text": "Current ratio is 0.570", "ids": ["F1"]}]}

        result = run_arms(call, {"F1": "Company current ratio = 0.570"},
                          {"T1": "Management discusses its credit line."}, debate_only=True)
        self.assertEqual(set(result["rebuttal_retries"]), set(LENSES))
        self.assertEqual(result["rebuttal_flags"], [])
        self.assertEqual({role for role, _, _ in seen}, set(VOICES))
        self.assertEqual(result["referee"]["Cash Flow & Debt"], ["supported"])
        self.assertEqual(check_claim({"text": "Current ratio is 0.850", "ids": ["F1"]},
                                     {"F1": "Company current ratio = 0.570"}), "contradicted")

    def test_older_quarter_cannot_support_latest_quarter_cash_flow_claim(self):
        evidence = {
            "F12": "Q-7: operating cash flow = 555 million USD",
            "F110": "Q0: operating cash flow = 2.17 billion USD",
            "F117": "Last four quarters added up: operating cash flow = 6.41 billion USD",
        }
        claim = {"text": "Last reported quarter cash flow was $555 million.", "ids": ["F12", "F117"]}
        self.assertEqual(check_claim(claim, evidence), "contradicted")
        claim = {"text": "Last reported quarter cash flow was $2.17 billion.", "ids": ["F110"]}
        self.assertEqual(check_claim(claim, evidence), "supported")
