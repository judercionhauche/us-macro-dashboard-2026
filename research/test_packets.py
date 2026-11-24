from dataclasses import replace
from datetime import date
import math
import unittest

from research.features import ratios
from research.packets import numeric_packet
from research.sec_facts import Fact, Measure, trailing_four


class PacketTests(unittest.TestCase):
    def setUp(self):
        self.cutoff = date(2024, 6, 30)
        self.fact = Fact("Assets", "USD", None, date(2024, 3, 31),
                         date(2024, 5, 1), "test", 100)
        self.row = {name: Measure(value, (self.fact,))
                    for name, value in dict(assets=100, debt=30, current_assets=25,
                                            current_liabilities=15, cash=10, liabilities=55,
                                            equity=45, retained=20, revenue=30, ebit=8,
                                            interest=2, net_income=4, operating_cash_flow=6,
                                            dividends_paid=1).items()}

    def test_model_packet_fails_with_late_provenance(self):
        late = replace(self.fact, filed=date(2024, 7, 1))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            numeric_packet({late.end: {"assets": Measure(late.value, (late,))}},
                           self.cutoff, 320193, {})

    def test_ratio_values_survive_dollar_scaling(self):
        scaled = {key: Measure(measure.value * 1.7, measure.sources)
                  for key, measure in self.row.items()}
        original = ratios([self.row] * 8)
        result = ratios([scaled] * 8)
        for name, value in original.items():
            if name == "log_assets":
                self.assertAlmostEqual(result[name] - value, math.log(1.7))
            elif math.isfinite(value):
                self.assertAlmostEqual(value, result[name], msg=name)

    def test_numeric_packet_uses_relative_quarters(self):
        packet = numeric_packet({self.fact.end: self.row}, self.cutoff, 320193, {})
        text = "\n".join(packet.values())
        self.assertNotIn("320193", text)
        self.assertNotIn("2024", text)
        self.assertIn("Q-7:", text)
        self.assertIn("Q0:", text)


    def test_quarter_order_and_trailing_cash_flow_use_the_same_values(self):
        ends = [date(2022, 6, 30), date(2022, 9, 30), date(2022, 12, 31),
                date(2023, 3, 31), date(2023, 6, 30), date(2023, 9, 30),
                date(2023, 12, 31), date(2024, 3, 31)]
        values = (1, 2, 3, 4, 100, -100, 200, 350)
        history = {end: {"operating_cash_flow": Measure(value, (self.fact,))}
                   for end, value in reversed(list(zip(ends, values)))}
        packet = list(numeric_packet(history, self.cutoff, 320193, {}, mode="demo").values())
        flow = [line for line in packet if line.startswith("Q") and "operating cash flow" in line]
        self.assertEqual([line.split(":")[0] for line in flow],
                         [f"Q{lag}" for lag in range(-7, 1)])
        self.assertTrue(flow[-1].endswith("350 USD"))
        ttm = trailing_four(history[end]["operating_cash_flow"] for end in ends[-4:])
        self.assertEqual(ttm.value, 550)
        self.assertIn("Last four quarters added up: operating cash flow = 550 USD", packet)
        research = numeric_packet(history, self.cutoff, 320193, {})
        self.assertNotIn("Last four quarters added up: operating cash flow = 550 USD", research.values())
