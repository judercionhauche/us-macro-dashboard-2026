from datetime import date
import unittest

from research.agents import check_claim
from research.live_tools import AnalysisTools, eligible_chunks
from research.live_debate import ROLE_OPENING_TOOLS, live_panel
from research.sec_facts import Fact, Measure


class LiveToolTests(unittest.TestCase):
    def test_future_filing_not_retrieved(self):
        cutoff = date(2024,12,31)
        chunks = eligible_chunks([(date(2025,1,1), ("Future text",)),
                                  (date(2024,11,1), ("Eligible text",))], cutoff)
        self.assertEqual(chunks, ((date(2024,11,1), "Eligible text"),))

    def test_values_require_valid_filing_and_evidence_id(self):
        cutoff = date(2024,12,31)
        end = date(2024,9,30)
        late = Fact("Assets","USD",None,end,date(2025,1,1),"late",2000)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            AnalysisTools({end:{"assets":Measure(2000,(late,))}}, cutoff, {}, [])
        good = AnalysisTools({end:{"cash":Measure(2000,())}}, cutoff, {}, [])
        result = good.ask("get_metric","cash")
        self.assertEqual(check_claim({"ids":[result["evidence_id"]],"text":"Cash was $2.00 thousand."},
                                     good.evidence),"supported")
        self.assertEqual(check_claim({"ids":["F999"],"text":"Cash was $2.00 thousand."},
                                     good.evidence),"contradicted")

    def test_balanced_panel_rotates_and_records_three_turns_each(self):
        cutoff = date(2024,12,31)
        tools = AnalysisTools({}, cutoff, {}, [])
        spoken = []
        floor = []

        def call(arm, role, round_number, system, context, **kwargs):
            if "tool" in kwargs:
                names = ROLE_OPENING_TOOLS.get(role, ()) if round_number == 1 else ()
                return {"requests": [
                    dict(name=name, metric="net_margin", quarters_back=0, question="")
                    for name in (names or ("get_metric",))
                ]}
            return {"p":.3,"risk_percent":30,"say":"word "*60,"claims":[]}

        result = live_panel(call, tools, lambda role, *args:floor.append(role),
                            lambda role, round_number, *args:spoken.append((role, round_number)))
        self.assertTrue(all(count == 3 for count in result["turn_counts"].values()))
        self.assertEqual(len(set(spoken[i][0] for i in (0,4,8))), 3)
        self.assertEqual(len(floor), 8)
        self.assertEqual(spoken[-1], ("moderator",4))
