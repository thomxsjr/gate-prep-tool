-- ===========================================================================
-- 003_answer_key
--
-- Applying the official GATE DA 2026 key to the imported response sheet
-- established two facts the schema had no way to record.
--
-- 1. QUESTION ORDER IS SHUFFLED PER CANDIDATE. The response sheet numbers
--    questions in the order they were shown; the key numbers them by the
--    master paper. `paper_q_no` records the master number so the two can be
--    joined. The join is made on the exam's question ID (`external_ref`),
--    never on position — position matching was verified to be wrong for all
--    65 questions.
--
-- 2. OPTION ORDER IS ALSO SHUFFLED. "Chosen Option: A" on a response sheet
--    means the option displayed to THIS candidate in position A, which is not
--    the master paper's option A. Measured on the 2026 sitting:
--
--        NAT  (no options to shuffle)  61.1% accuracy on attempted
--        MCQ  (options)                28.6%   — chance is 25.0%
--        MSQ  (options)                14.3%   — chance is ~6.7%
--
--    If MCQ skill matched NAT skill, P(<= 8 correct of 28) = 0.0005. The
--    recorded letters are noise with respect to the key.
--
--    `option_labels_comparable` is the guard. When 0, no code may score the
--    question by comparing the recorded letter to the key — that path
--    produces a confident, badly wrong number (21.00 against a true 53.00).
--    Only a human who can see the paper can resolve these.
-- ===========================================================================

ALTER TABLE questions ADD COLUMN paper_q_no INTEGER;
CREATE INDEX idx_questions_paper_q_no ON questions (paper_q_no);

ALTER TABLE questions ADD COLUMN option_labels_comparable INTEGER NOT NULL DEFAULT 1
  CHECK (option_labels_comparable IN (0, 1));

-- Provenance for how an outcome was established, so a machine-scored row is
-- never mistaken for one a human resolved.
ALTER TABLE attempts ADD COLUMN outcome_source TEXT
  CHECK (outcome_source IS NULL OR
         outcome_source IN ('answer_key', 'response_sheet', 'manual'));

-- Questions that can be auto-scored from a key, versus those that need a human.
CREATE VIEW v_key_scorable AS
SELECT
  q.id,
  q.source_id,
  q.source_q_no,
  q.paper_q_no,
  q.qtype,
  q.marks,
  q.correct_answer,
  q.answer_tolerance,
  q.option_labels_comparable,
  CASE
    WHEN q.correct_answer IS NULL THEN 'no_key'
    WHEN q.qtype = 'NAT' THEN 'auto'
    WHEN q.option_labels_comparable = 1 THEN 'auto'
    ELSE 'needs_human'
  END AS scorability
FROM questions q;
