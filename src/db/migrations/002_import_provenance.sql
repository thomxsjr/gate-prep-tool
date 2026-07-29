-- ===========================================================================
-- 002_import_provenance
--
-- Driven by importing the real GATE DA 2026 response sheet, which revealed
-- two gaps in 001:
--
-- 1. A response sheet carries the exam's own question ID. It is a reference,
--    not content, and it is what lets an official answer key be matched to
--    these rows later. `questions.external_ref` holds it.
--
-- 2. `attempts.outcome` was NOT NULL, which cannot represent the true state
--    after a bulk import: the candidate's chosen option is known, but whether
--    it was right is not, because the response sheet publishes no key.
--    Forcing a value would fabricate data — exactly what this instrument
--    exists to prevent. Outcome is now nullable and means "not yet
--    determined", which pairs with the `triaged_at IS NULL` state the
--    two-stage log already relies on. Every metric already excludes untriaged
--    rows, so a null outcome cannot leak into a headline number.
-- ===========================================================================

ALTER TABLE questions ADD COLUMN external_ref TEXT;
CREATE INDEX idx_questions_external_ref ON questions (external_ref);

-- `section` is derivable from the subject, but a response sheet gives the
-- section directly and question numbers restart within it.
ALTER TABLE questions ADD COLUMN section TEXT
  CHECK (section IS NULL OR section IN ('GA', 'SUBJECT'));

-- SQLite cannot relax NOT NULL in place, so `attempts` is rebuilt.
--
-- The views must go FIRST: SQLite validates view bodies when the tables they
-- reference change, so dropping `attempts` while v_scored_attempts still
-- names it fails the whole migration.
--
-- The migration runner disables foreign keys around this (see migrate.ts) and
-- re-checks integrity afterwards. Without that, dropping `attempts` would fire
-- attempt_options' ON DELETE CASCADE and destroy every per-option verdict.
DROP VIEW IF EXISTS v_scored_attempts;
DROP VIEW IF EXISTS v_leak_by_class;
DROP VIEW IF EXISTS v_concept_cost;
DROP VIEW IF EXISTS v_triage_queue;

CREATE TABLE attempts_new (
  id               INTEGER PRIMARY KEY,
  question_id      INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  mock_id          INTEGER REFERENCES mocks (id) ON DELETE SET NULL,
  context          TEXT NOT NULL
    CHECK (context IN ('practice', 'mock', 'sectional', 'pyq', 'drill', 'review')),
  attempted_at     TEXT NOT NULL,
  my_answer        TEXT,
  -- NULL = attempted, outcome not yet determined (no key, or not yet marked).
  outcome          TEXT
    CHECK (outcome IS NULL OR
           outcome IN ('correct', 'wrong', 'skipped', 'correct_but_guessed')),
  marks_available  REAL NOT NULL,
  marks_obtained   REAL,
  marks_lost       REAL,
  time_seconds     INTEGER,
  confidence       INTEGER CHECK (confidence BETWEEN 0 AND 100),
  error_class_id   INTEGER REFERENCES error_classes (id) ON DELETE SET NULL,
  what_i_thought   TEXT NOT NULL DEFAULT '',
  broke_at_step    TEXT NOT NULL DEFAULT '',
  prevention_rule  TEXT NOT NULL DEFAULT '',
  attempt_no       INTEGER NOT NULL DEFAULT 1,
  is_first_attempt INTEGER NOT NULL DEFAULT 1
    CHECK (is_first_attempt IN (0, 1)),
  captured_at      TEXT NOT NULL,
  triaged_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- A triaged attempt must have an outcome and an error class if it lost marks.
  CHECK (triaged_at IS NULL OR outcome IS NOT NULL),
  UNIQUE (question_id, attempt_no)
);

INSERT INTO attempts_new
SELECT id, question_id, mock_id, context, attempted_at, my_answer, outcome,
       marks_available, marks_obtained, marks_lost, time_seconds, confidence,
       error_class_id, what_i_thought, broke_at_step, prevention_rule,
       attempt_no, is_first_attempt, captured_at, triaged_at, created_at, updated_at
FROM attempts;

DROP TABLE attempts;
ALTER TABLE attempts_new RENAME TO attempts;

CREATE INDEX idx_attempts_question ON attempts (question_id);
CREATE INDEX idx_attempts_mock ON attempts (mock_id);
CREATE INDEX idx_attempts_at ON attempts (attempted_at);
CREATE INDEX idx_attempts_error_class ON attempts (error_class_id);
CREATE INDEX idx_attempts_triage ON attempts (triaged_at);

-- Views rebuilt against the new table.
CREATE VIEW v_scored_attempts AS
SELECT
  a.id, a.question_id, a.mock_id, a.context, a.attempted_at, a.outcome,
  a.marks_available, a.marks_obtained, a.marks_lost, a.time_seconds,
  a.confidence, a.error_class_id, a.is_first_attempt, a.triaged_at,
  ec.code AS error_code, ec.name AS error_name, ec.is_procedural AS is_procedural,
  q.marks, q.qtype, q.subject_id, s.name AS subject_name
FROM attempts a
LEFT JOIN error_classes ec ON ec.id = a.error_class_id
JOIN questions q ON q.id = a.question_id
LEFT JOIN subjects s ON s.id = q.subject_id
WHERE a.context IN ('mock', 'sectional', 'pyq', 'practice')
  AND a.triaged_at IS NOT NULL;

CREATE VIEW v_leak_by_class AS
SELECT ec.id AS error_class_id, ec.code, ec.name, ec.is_procedural,
       COUNT(v.id) AS occurrences, SUM(v.marks_lost) AS marks_lost
FROM error_classes ec
LEFT JOIN v_scored_attempts v ON v.error_class_id = ec.id
GROUP BY ec.id;

CREATE VIEW v_concept_cost AS
SELECT c.id AS concept_id, c.name,
       COUNT(DISTINCT a.question_id) AS questions,
       COUNT(a.id) AS attempts,
       COALESCE(SUM(a.marks_lost), 0) AS marks_lost
FROM concepts c
LEFT JOIN questions q ON q.concept_id = c.id
LEFT JOIN attempts a ON a.question_id = q.id
GROUP BY c.id;

CREATE VIEW v_triage_queue AS
SELECT a.id, a.question_id, a.attempted_at, a.captured_at, a.outcome,
       q.marks, q.qtype, q.section, q.source_q_no
FROM attempts a
JOIN questions q ON q.id = a.question_id
WHERE a.triaged_at IS NULL
ORDER BY a.captured_at ASC;
