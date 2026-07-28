-- ===========================================================================
-- 001_init — GATE DA 2027 procedural-error instrument
--
-- CONTENT POLICY (enforced by convention, see SPEC non-goals):
--   No table in this schema stores third-party question or option text.
--   `questions.paraphrase` and `question_options.paraphrase` are the user's
--   OWN words. Original material stays in a locally-owned PDF, referenced by
--   path only and never committed.
--
-- MARKS ARITHMETIC:
--   Marks columns are REAL for readability, but the scoring engine computes
--   in integer THIRDS and only divides at the boundary. See src/domain/scoring.ts
--   for why (1/3 is not representable in binary and this instrument is not
--   allowed to drift).
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Config. Single editable KV, seeded from config.seed.json.
-- --------------------------------------------------------------------------
CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  grp         TEXT NOT NULL,
  label       TEXT,
  -- GATE 2027 dates and marking rules MUST be checked against the official
  -- brochure before Phase 3. The UI shows a standing banner while this is 0.
  verified_against_brochure INTEGER NOT NULL DEFAULT 0
    CHECK (verified_against_brochure IN (0, 1)),
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_config_grp ON config (grp);

-- --------------------------------------------------------------------------
-- Taxonomy
-- --------------------------------------------------------------------------
CREATE TABLE error_classes (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- The single most important boolean in the schema. It is the numerator
  -- selector for procedural share.
  is_procedural INTEGER NOT NULL CHECK (is_procedural IN (0, 1)),
  description   TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE subjects (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  section    TEXT NOT NULL CHECK (section IN ('GA', 'SUBJECT')),
  sort_order INTEGER NOT NULL
);

CREATE TABLE topics (
  id         INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  UNIQUE (subject_id, name)
);

CREATE TABLE concepts (
  id         INTEGER PRIMARY KEY,
  subject_id INTEGER REFERENCES subjects (id) ON DELETE SET NULL,
  name       TEXT NOT NULL UNIQUE,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- The Ladder
-- --------------------------------------------------------------------------
CREATE TABLE rungs (
  id               INTEGER PRIMARY KEY,
  ordinal          INTEGER NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  items_target     INTEGER NOT NULL,
  marks_swing      REAL NOT NULL,
  -- Retrodictive: "score if the 2026 paper were re-sat with this rung closed".
  -- NOT a forecast. The UI must label it as such.
  cumulative_score REAL NOT NULL,
  error_class_id   INTEGER REFERENCES error_classes (id) ON DELETE SET NULL,
  is_procedural    INTEGER NOT NULL CHECK (is_procedural IN (0, 1))
);

-- --------------------------------------------------------------------------
-- Sources and the question record
-- --------------------------------------------------------------------------
CREATE TABLE sources (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('pyq', 'mock', 'sectional', 'drill')),
  exam           TEXT,
  year           INTEGER,
  paper          TEXT,
  label          TEXT NOT NULL UNIQUE,
  local_pdf_path TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE questions (
  id               INTEGER PRIMARY KEY,
  source_id        INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  source_q_no      TEXT,
  marks            REAL NOT NULL CHECK (marks IN (1, 2)),
  qtype            TEXT NOT NULL CHECK (qtype IN ('MCQ', 'MSQ', 'NAT')),
  subject_id       INTEGER REFERENCES subjects (id) ON DELETE SET NULL,
  -- MY paraphrase. Never third-party text.
  paraphrase       TEXT NOT NULL DEFAULT '',
  correct_answer   TEXT,
  -- NAT answers are ranges in the official key. Scoring without a tolerance
  -- manufactures false wrongs.
  answer_tolerance REAL,
  concept_id       INTEGER REFERENCES concepts (id) ON DELETE SET NULL,
  rung_id          INTEGER REFERENCES rungs (id) ON DELETE SET NULL,
  local_pdf_path   TEXT,
  page_no          INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (source_id, source_q_no)
);
CREATE INDEX idx_questions_subject ON questions (subject_id);
CREATE INDEX idx_questions_rung ON questions (rung_id);
CREATE INDEX idx_questions_concept ON questions (concept_id);

CREATE TABLE question_topics (
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  topic_id    INTEGER NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, topic_id)
);

-- Variable-N. GATE MSQs are not always 4 options.
CREATE TABLE question_options (
  id          INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  paraphrase  TEXT NOT NULL DEFAULT '',
  is_correct  INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)),
  sort_order  INTEGER NOT NULL,
  UNIQUE (question_id, label)
);

CREATE TABLE rung_items (
  id          INTEGER PRIMARY KEY,
  rung_id     INTEGER NOT NULL REFERENCES rungs (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('question', 'concept', 'habit')),
  status      TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'closed')),
  question_id INTEGER REFERENCES questions (id) ON DELETE SET NULL,
  concept_id  INTEGER REFERENCES concepts (id) ON DELETE SET NULL,
  notes       TEXT NOT NULL DEFAULT '',
  closed_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_rung_items_rung ON rung_items (rung_id);

-- --------------------------------------------------------------------------
-- Mocks
-- --------------------------------------------------------------------------
CREATE TABLE mocks (
  id                  INTEGER PRIMARY KEY,
  source_id           INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  date                TEXT NOT NULL,
  started_at          TEXT,
  -- Set by the 09:15-09:45 window rule. All mock analytics segment on it.
  started_at_0930     INTEGER NOT NULL DEFAULT 0 CHECK (started_at_0930 IN (0, 1)),
  environment         TEXT NOT NULL DEFAULT 'home'
    CHECK (environment IN ('home', 'away')),
  duration_minutes    INTEGER,
  raw_score           REAL,
  attempted           INTEGER,
  correct             INTEGER,
  wrong               INTEGER,
  skipped             INTEGER,
  marks_lost_negative REAL,
  -- Score reveal is blocked until this is set. Non-null == triage complete.
  triage_completed_at TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_mocks_date ON mocks (date);

-- --------------------------------------------------------------------------
-- Attempts — the spine
-- --------------------------------------------------------------------------
CREATE TABLE attempts (
  id               INTEGER PRIMARY KEY,
  question_id      INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  mock_id          INTEGER REFERENCES mocks (id) ON DELETE SET NULL,
  -- 'drill' is deliberately excluded from procedural-share denominators.
  context          TEXT NOT NULL
    CHECK (context IN ('practice', 'mock', 'sectional', 'pyq', 'drill', 'review')),
  attempted_at     TEXT NOT NULL,
  my_answer        TEXT,
  outcome          TEXT NOT NULL
    CHECK (outcome IN ('correct', 'wrong', 'skipped', 'correct_but_guessed')),
  marks_available  REAL NOT NULL,
  marks_obtained   REAL NOT NULL,
  -- available - obtained. A wrong 1-mark MCQ loses 1.333; a skip loses 1.000.
  marks_lost       REAL NOT NULL,
  time_seconds     INTEGER,
  confidence       INTEGER CHECK (confidence BETWEEN 0 AND 100),
  error_class_id   INTEGER REFERENCES error_classes (id) ON DELETE SET NULL,

  -- Stage 2 diagnosis fields. Structure, not a character count, is the friction.
  what_i_thought   TEXT NOT NULL DEFAULT '',
  broke_at_step    TEXT NOT NULL DEFAULT '',
  prevention_rule  TEXT NOT NULL DEFAULT '',

  attempt_no       INTEGER NOT NULL DEFAULT 1,
  is_first_attempt INTEGER NOT NULL DEFAULT 1
    CHECK (is_first_attempt IN (0, 1)),

  -- Two-stage log. captured_at is always set; triaged_at is null until the
  -- diagnosis is written. Untriaged rows are EXCLUDED from procedural share
  -- so the metric cannot be gamed by leaving hard entries unlabelled.
  captured_at      TEXT NOT NULL,
  triaged_at       TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (question_id, attempt_no)
);
CREATE INDEX idx_attempts_question ON attempts (question_id);
CREATE INDEX idx_attempts_mock ON attempts (mock_id);
CREATE INDEX idx_attempts_at ON attempts (attempted_at);
CREATE INDEX idx_attempts_error_class ON attempts (error_class_id);
CREATE INDEX idx_attempts_triage ON attempts (triaged_at);

-- M3's real metric lives here as rows, not as a JSON blob, because
-- per-option accuracy has to be queryable.
CREATE TABLE attempt_options (
  id                 INTEGER PRIMARY KEY,
  attempt_id         INTEGER NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  question_option_id INTEGER NOT NULL REFERENCES question_options (id) ON DELETE CASCADE,
  my_verdict         INTEGER NOT NULL CHECK (my_verdict IN (0, 1)),
  justification      TEXT NOT NULL DEFAULT '',
  is_verdict_correct INTEGER NOT NULL CHECK (is_verdict_correct IN (0, 1)),
  seconds            INTEGER,
  UNIQUE (attempt_id, question_option_id)
);
CREATE INDEX idx_attempt_options_attempt ON attempt_options (attempt_id);

-- --------------------------------------------------------------------------
-- Spaced repetition
-- --------------------------------------------------------------------------
CREATE TABLE cards (
  id                INTEGER PRIMARY KEY,
  type              TEXT NOT NULL
    CHECK (type IN ('formula', 'definition', 'procedure', 'counterexample', 'boundary')),
  front             TEXT NOT NULL,
  back              TEXT NOT NULL,
  subject_id        INTEGER REFERENCES subjects (id) ON DELETE SET NULL,
  concept_id        INTEGER REFERENCES concepts (id) ON DELETE SET NULL,
  -- The error that spawned this card.
  origin_attempt_id INTEGER REFERENCES attempts (id) ON DELETE SET NULL,
  due_date          TEXT NOT NULL,
  interval_days     REAL NOT NULL DEFAULT 0,
  ease              REAL NOT NULL DEFAULT 2.5,
  reps              INTEGER NOT NULL DEFAULT 0,
  lapses            INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at  TEXT,
  suspended         INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_cards_due ON cards (due_date, suspended);

CREATE TABLE card_reviews (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  reviewed_at   TEXT NOT NULL,
  grade         INTEGER NOT NULL CHECK (grade BETWEEN 0 AND 5),
  prev_interval REAL NOT NULL,
  new_interval  REAL NOT NULL,
  prev_ease     REAL NOT NULL,
  new_ease      REAL NOT NULL,
  seconds       INTEGER
);
CREATE INDEX idx_card_reviews_card ON card_reviews (card_id);

-- --------------------------------------------------------------------------
-- Drills (M4). Templates live in TS; only runs are persisted.
-- --------------------------------------------------------------------------
CREATE TABLE drill_runs (
  id            INTEGER PRIMARY KEY,
  template_key  TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  params_json   TEXT NOT NULL,
  expected      TEXT NOT NULL,
  given         TEXT,
  correct       INTEGER NOT NULL CHECK (correct IN (0, 1)),
  seconds       INTEGER,
  -- Wrong runs auto-create an attempts row tagged to the boundary class.
  attempt_id    INTEGER REFERENCES attempts (id) ON DELETE SET NULL,
  run_at        TEXT NOT NULL
);
CREATE INDEX idx_drill_runs_template ON drill_runs (template_key, run_at);

-- --------------------------------------------------------------------------
-- Study sessions
-- --------------------------------------------------------------------------
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  date            TEXT NOT NULL,
  block           TEXT NOT NULL
    CHECK (block IN ('morning_formula', 'deep_work', 'evening', 'recall')),
  subject_id      INTEGER REFERENCES subjects (id) ON DELETE SET NULL,
  planned_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes  INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_date ON sessions (date);

-- ===========================================================================
-- Views. Convenience for the UI only.
--
-- The four computations the spec requires to be correct (scoring, EV, SM-2,
-- procedural share) are PURE TYPESCRIPT in src/domain/, unit-tested there.
-- Nothing load-bearing is defined in SQL, so nothing load-bearing escapes
-- the test suite.
-- ===========================================================================

-- Attempts eligible for the procedural-share metric:
--   - real work only (drills excluded by construction)
--   - triaged only (an untriaged row has no verified error class)
CREATE VIEW v_scored_attempts AS
SELECT
  a.id,
  a.question_id,
  a.mock_id,
  a.context,
  a.attempted_at,
  a.outcome,
  a.marks_available,
  a.marks_obtained,
  a.marks_lost,
  a.time_seconds,
  a.confidence,
  a.error_class_id,
  a.is_first_attempt,
  a.triaged_at,
  ec.code          AS error_code,
  ec.name          AS error_name,
  ec.is_procedural AS is_procedural,
  q.marks,
  q.qtype,
  q.subject_id,
  s.name           AS subject_name
FROM attempts a
LEFT JOIN error_classes ec ON ec.id = a.error_class_id
JOIN questions q ON q.id = a.question_id
LEFT JOIN subjects s ON s.id = q.subject_id
WHERE a.context IN ('mock', 'sectional', 'pyq', 'practice')
  AND a.triaged_at IS NOT NULL;

-- Leak table source: marks lost per error class, all time. Window filtering
-- happens in TS so the same code path serves every window.
CREATE VIEW v_leak_by_class AS
SELECT
  ec.id            AS error_class_id,
  ec.code,
  ec.name,
  ec.is_procedural,
  COUNT(v.id)      AS occurrences,
  SUM(v.marks_lost) AS marks_lost
FROM error_classes ec
LEFT JOIN v_scored_attempts v ON v.error_class_id = ec.id
GROUP BY ec.id;

-- Cost of a concept: "this concept has cost me N marks across M questions."
CREATE VIEW v_concept_cost AS
SELECT
  c.id   AS concept_id,
  c.name,
  COUNT(DISTINCT a.question_id) AS questions,
  COUNT(a.id)                   AS attempts,
  COALESCE(SUM(a.marks_lost), 0) AS marks_lost
FROM concepts c
LEFT JOIN questions q ON q.concept_id = c.id
LEFT JOIN attempts a ON a.question_id = q.id
GROUP BY c.id;

-- The triage backlog. Depth is itself a discipline metric.
CREATE VIEW v_triage_queue AS
SELECT a.id, a.question_id, a.attempted_at, a.captured_at, a.outcome, q.marks, q.qtype
FROM attempts a
JOIN questions q ON q.id = a.question_id
WHERE a.triaged_at IS NULL
ORDER BY a.captured_at ASC;
