"""Contract tests for failures that must not enter published learning content."""
import copy
import unittest
from revise import balance_choices, validate, modern_narrative


class RevisionContractTests(unittest.TestCase):
    def setUp(self):
        self.job = {"min_chars": 10, "max_chars": 30, "question_count": 3, "grade": 1, "references": []}
        self.story = {"title": "小花", "image_prompt": "孩子给小花浇水", "sentences": ["小明看见小花低着头。", "他提来水壶给花浇水。"],
            "questions": [{"id": i + 1, "type": "choice", "question": f"问题{i}",
                           "options": ["答案", "误读一", "误读二", "误读三"], "answer": "答案",
                           "explanation": "根据人物行动推断。", "skill": skill,
                           "evidence_sentence_indices": [1, 2]}
                          for i, skill in enumerate(["retrieval", "vocabulary", "inference"])]}

    def test_valid_contract(self):
        self.assertEqual(validate(self.story, self.job), [])

    def test_classical_text_is_not_modern_story_length_benchmark(self):
        self.assertFalse(modern_narrative({'kind':'story','title':'王戎不取道旁李'}))
        self.assertTrue(modern_narrative({'kind':'story','title':'扁鹊治病'}))

    def test_positional_explanation_is_rejected(self):
        self.story['questions'][0]['explanation']='第二个选项符合人物行动。'
        self.assertTrue(any('选项位置' in e for e in validate(self.story,self.job)))

    def test_shorter_is_rejected(self):
        self.story["sentences"] = ["小花。"]
        self.assertTrue(any("汉字数" in e for e in validate(self.story, self.job)))

    def test_missing_evidence_is_rejected(self):
        self.story["questions"][0]["evidence_sentence_indices"] = [0, 3]
        self.assertTrue(any("证据" in e for e in validate(self.story, self.job)))

    def test_duplicate_options_are_rejected(self):
        self.story["questions"][0]["options"][1] = "答案"
        self.assertTrue(any("选项" in e for e in validate(self.story, self.job)))

    def test_open_answer_is_not_a_fill_blank(self):
        self.story["questions"][0].update(type="fill_blank_text", answer="他很热爱大自然", options=[])
        self.assertTrue(any("填空" in e for e in validate(self.story, self.job)))

    def test_balance_preserves_answers_and_is_idempotent(self):
        balance_choices(self.story, 1)
        positions = [q["options"].index(q["answer"]) for q in self.story["questions"]]
        self.assertEqual(len(set(positions)), len(positions))
        balanced = copy.deepcopy(self.story)
        balance_choices(self.story, 1)
        self.assertEqual(self.story, balanced)


if __name__ == "__main__":
    unittest.main()
