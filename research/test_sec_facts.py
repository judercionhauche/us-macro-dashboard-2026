from dataclasses import replace
from datetime import date
import unittest

from research.sec_facts import Fact, first_filed, quarter_flow, validate_cutoff


class PointInTimeTests(unittest.TestCase):
    def test_first_filed_survives_a_later_restatement(self):
        original = dict(form="10-Q", end="2024-03-31", filed="2024-05-10", accn="a", val=100)
        restated = dict(original, form="10-Q/A", filed="2024-08-12", accn="b", val=200)
        not_yet_filed = dict(original, end="2024-06-30", filed="2024-08-12", accn="c")
        payload = {"facts": {"us-gaap": {"Assets": {"units": {
            "USD": [restated, not_yet_filed, original],
        }}}}}
        cutoff = date(2024, 6, 30)
        facts = first_filed(payload, cutoff)
        self.assertEqual([(f.accession, f.value) for f in facts], [("a", 100)])
        validate_cutoff(cutoff, facts)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            validate_cutoff(cutoff, [*facts, replace(facts[0], filed=date(2024, 7, 1))])
        self.assertEqual(
            next(f for f in first_filed(payload, date(2024, 9, 30)) if f.end.month == 3).value,
            100,
        )

    def test_q4_subtracts_nine_months_and_retains_both_filing_dates(self):
        start = date(2023, 1, 1)
        nine_months = Fact("NetIncomeLoss", "USD", start, date(2023, 9, 30),
                           date(2023, 11, 1), "nine", 75)
        year = Fact("NetIncomeLoss", "USD", start, date(2023, 12, 31),
                    date(2024, 2, 1), "year", 100)
        result = quarter_flow(
            [year, nine_months], tags=("NetIncomeLoss",), unit="USD",
            fiscal_start=start, quarter_start=date(2023, 10, 1),
            quarter_end=year.end, previous_end=nine_months.end,
        )
        self.assertEqual(result.value, 25)
        validate_cutoff(date(2024, 2, 1), result.sources)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            validate_cutoff(date(2023, 12, 31), result.sources)
