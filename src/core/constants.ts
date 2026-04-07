// ── Concurrency ──────────────────────────────────────────────────────────────
export const MAX_CONCURRENT_LSP_REQUESTS = 8;

// ── Cache ────────────────────────────────────────────────────────────────────
export const CACHE_MAX_ENTRIES = 500;

// ── History & Pins ───────────────────────────────────────────────────────────
export const MAX_REFERENCE_HISTORY = 20;
export const MAX_PINNED_RESULTS = 20;
export const AUTO_EXPAND_THRESHOLD = 20;

// ── Symbol ranking scores ────────────────────────────────────────────────────
export const SCORE_EXACT_MATCH = 5000;
export const SCORE_STARTS_WITH = 4000;
export const SCORE_CAMEL_CASE = 3000;
export const SCORE_CONTAINS = 2000;
export const SCORE_LSP_BASE = 1000;
export const SCORE_TEST_PENALTY = -800;
export const SCORE_LANG_BOOST = 600;
export const SCORE_KIND_CLASS = 500;
export const SCORE_KIND_FUNCTION = 400;
export const SCORE_PATH_WORKSPACE = 300;
export const SCORE_KIND_VARIABLE = 200;
export const SCORE_PROXIMITY_SAME_DIR = 200;
export const SCORE_PROXIMITY_SIBLING = 100;
export const SCORE_KIND_DEFAULT = 100;
export const SCORE_RECENT_MAX = 800;
export const SCORE_RECENT_DECAY = 16;
export const SCORE_LENGTH_PENALTY_CAP = 100;
export const MAX_RECENT_SYMBOLS = 50;

// ── Proto ────────────────────────────────────────────────────────────────────
export const MAX_PROTO_FILTERED_SYMBOLS = 20;
