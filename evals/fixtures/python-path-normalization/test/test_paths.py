import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from src.paths import normalize_segments


class NormalizeSegmentsTest(unittest.TestCase):
    def test_resolves_internal_parent(self) -> None:
        self.assertEqual(normalize_segments(["src", "old", "..", "new.py"]), ["src", "new.py"])

    def test_clamps_leading_and_extra_parents(self) -> None:
        self.assertEqual(normalize_segments(["..", "..", "safe", "..", ".."]), [])


if __name__ == "__main__":
    unittest.main()
