/** Types shared by the API and the client. No runtime dependencies. */

export type QType = 'MCQ' | 'MSQ' | 'NAT';
export type Outcome = 'correct' | 'wrong' | 'skipped' | 'correct_but_guessed';
export type Context = 'practice' | 'mock' | 'sectional' | 'pyq' | 'drill' | 'review';
export type CardType = 'formula' | 'definition' | 'procedure' | 'counterexample' | 'boundary';
export type Block = 'morning_formula' | 'deep_work' | 'evening' | 'recall';

export interface ErrorClass {
  id: number;
  code: string;
  name: string;
  is_procedural: boolean;
  description: string;
  sort_order: number;
}

export interface Subject {
  id: number;
  code: string;
  name: string;
  section: 'GA' | 'SUBJECT';
  sort_order: number;
}

export interface RungRow {
  id: number;
  ordinal: number;
  name: string;
  description: string;
  items_target: number;
  marks_swing: number;
  cumulative_score: number;
  error_class_id: number | null;
  is_procedural: boolean;
}

export interface AttemptRow {
  id: number;
  question_id: number;
  source_label: string | null;
  source_q_no: string | null;
  paper_q_no: number | null;
  qtype: QType;
  marks: number;
  subject_id: number | null;
  subject_name: string | null;
  paraphrase: string;
  correct_answer: string | null;
  context: Context;
  attempted_at: string;
  my_answer: string | null;
  outcome: Outcome | null;
  outcome_source: string | null;
  marks_lost: number | null;
  time_seconds: number | null;
  confidence: number | null;
  error_class_id: number | null;
  error_code: string | null;
  error_name: string | null;
  is_procedural: boolean | null;
  what_i_thought: string;
  broke_at_step: string;
  prevention_rule: string;
  attempt_no: number;
  is_first_attempt: boolean;
  captured_at: string;
  triaged_at: string | null;
  option_labels_comparable: boolean;
}

/** Stage 1 — must stay under 20 seconds. */
export interface CaptureInput {
  sourceLabel: string;
  sourceQNo?: string | null;
  qtype: QType;
  marks: 1 | 2;
  subjectId?: number | null;
  context: Context;
  outcome: Outcome;
  myAnswer?: string | null;
  correctAnswer?: string | null;
  timeSeconds?: number | null;
  confidence?: number | null;
  errorClassId?: number | null;
  paraphrase?: string;
  attemptedAt?: string;
}

/** Stage 2 — the diagnosis. Structure is the friction, not length alone. */
export interface TriageInput {
  errorClassId: number;
  outcome?: Outcome;
  whatIThought: string;
  brokeAtStep: string;
  preventionRule: string;
  confidence?: number | null;
  timeSeconds?: number | null;
  subjectId?: number | null;
  conceptName?: string | null;
  paraphrase?: string;
  createCard?: boolean;
}

export interface LeakRowDto {
  errorClassId: number;
  code: string;
  name: string;
  isProcedural: boolean;
  occurrences: number;
  marksLost: number;
  shareOfLoss: number;
}

export interface RungFillDto {
  ordinal: number;
  name: string;
  marksSwing: number;
  cumulativeScore: number;
  isProcedural: boolean;
  fill: number;
  residual: number;
  itemsClosed: number;
  itemsTarget: number;
  incidencePer100: number | null;
  sampleSize: number;
  insufficientData: boolean;
}

export interface DeckDto {
  ladder: {
    baselineScore: number;
    targetScore: number;
    rungs: RungFillDto[];
    recoverableScore: number;
    topClosedOrdinal: number;
  };
  procedural: {
    current: number | null;
    baseline: number;
    direction: 'falling' | 'rising' | 'flat' | 'unknown';
    series: { weekStart: string; share: number | null; attempts: number }[];
    marksLost: number;
    proceduralMarksLost: number;
    sampleSize: number;
  };
  phase: {
    ordinal: number;
    name: string;
    start: string | null;
    end: string | null;
    daysRemaining: number | null;
    gateLabel: string | null;
    gateStatus: 'on_track' | 'at_risk' | 'missed' | 'met' | 'unknown';
    gateDetail: string;
  } | null;
  countdown: {
    label: string;
    date: string;
    daysRemaining: number;
    alarm: boolean;
  }[];
  mocks: {
    rollingAverage: number | null;
    count: number;
    gateThreshold: number | null;
    homeAwayDelta: number | null;
    at0930Delta: number | null;
  };
  hours: { logged: number; min: number; max: number; weekStart: string };
  today: {
    dueCards: number;
    triageQueue: number;
    reattempts: number;
    recommendedDrill: { code: string; name: string; marksLost: number } | null;
  };
  unverified: string[];
}

export interface MsqOption {
  id: number;
  label: string;
  paraphrase: string;
  is_correct: boolean;
}

export interface MsqQuestion {
  questionId: number;
  sourceLabel: string;
  sourceQNo: string | null;
  marks: number;
  paraphrase: string;
  subjectName: string | null;
  options: MsqOption[];
  perOptionBudgetSeconds: number;
}

export interface MsqVerdictInput {
  questionId: number;
  verdicts: { optionId: number; myVerdict: boolean; justification: string; seconds: number }[];
  totalSeconds: number;
}

export interface MsqReport {
  perOptionAccuracy: number;
  perOptionTotal: number;
  perOptionRight: number;
  questionAccuracy: number;
  questionsAttempted: number;
  /** MSQs where all but one option verdict was right, scoring zero anyway. */
  nearMisses: number;
  trend: { date: string; accuracy: number; n: number }[];
}

export interface DrillQuestion {
  templateKey: string;
  templateName: string;
  seed: number;
  prompt: string;
  params: Record<string, number | string>;
  answerKind: 'integer' | 'number';
  timeBudgetSeconds: number;
}

export interface CalibrationDto {
  buckets: { decile: number; lo: number; hi: number; n: number; observed: number; statedMean: number }[];
  n: number;
  bias: number;
  brier: number;
  sufficient: boolean;
  minSampleSize: number;
  violations: {
    kind: string;
    marks: number;
    cost: number;
    detail: string;
    sourceQNo: string | null;
  }[];
  netPolicy: { gained: number; forgone: number; net: number };
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  procedural: { current: number | null; previous: number | null; direction: string };
  leak: LeakRowDto[];
  attack: LeakRowDto | null;
  hours: { logged: number; min: number; max: number };
  gate: { label: string; status: string; detail: string } | null;
  rungDelta: { ordinal: number; name: string; fill: number; previousFill: number }[];
  subjectAccuracy: { subject: string; attempts: number; accuracy: number; marksLost: number }[];
  mocks: { date: string; score: number; at0930: boolean; environment: string }[];
}
