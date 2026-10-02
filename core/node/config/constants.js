/**
 * Constants - All magic numbers centralized
 * 
 * Instead of hardcoded values scattered across the codebase,
 * all timing, limits, and thresholds are defined here.
 */

// ==================== TIMING ====================

/** Polling interval for analyzer data (ms) */
const POLL_INTERVAL_MS = 1000;

/** Session check interval (ms) */
const SESSION_CHECK_INTERVAL_MS = 60000;

/** Session cache TTL for pre-flight checks (ms) - 15 minutes
 * After successful login, trust the session for this duration without re-checking.
 * Reduces unnecessary re-logins which slow down bet placement (1-2 sec per login).
 */
const SESSION_CACHE_TTL_MS = 900000;

/** State file max age before considered stale (ms) - 1 hour */
const STATE_MAX_AGE_MS = 3600000;

/** Default HTTP timeout (ms) */
const HTTP_TIMEOUT_MS = 20000;

/** Post-bet delay for APIs with queue limits (ms) */
const POST_BET_DELAY_MS = 0;

/** Fresh data wait timeout (ms) */
const FRESH_DATA_TIMEOUT_MS = 7000;

/** Balance check interval when insufficient (minutes) */
const BALANCE_PAUSE_MINUTES = 15;

// ==================== STABILITY ====================

/** Fast strategy duration (seconds) */
const FAST_DURATION_SECONDS = 5;

/** Slow strategy duration (seconds) */
const SLOW_DURATION_SECONDS = 30;

/** Single strategy default duration (seconds)
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  ⛔ ЗАПРЕЩЕНО УМЕНЬШАТЬ ЭТО ЗНАЧЕНИЕ!                         ║
 * ║  Может показаться что 3s вместо 5s ускорит реакцию,          ║
 * ║  но это приведёт к ставкам на нестабильные линии!            ║
 * ║  5 секунд - минимум для подтверждения реального value.       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
const SINGLE_DURATION_SECONDS = 5;

/** Minimum updates required for stability */
const MIN_UPDATES_FOR_STABILITY = 2;

/** Tracker cleanup - max age before removal (ms) */
const TRACKER_MAX_AGE_MS = 30000;

// ==================== BETTING LIMITS ====================

/** Default minimum ROI threshold (%) */
const MIN_ROI = 3;

/** Maximum ROI threshold - bets above this are suspicious/blocked (%) */
const MAX_ROI = 25;

/** High ROI threshold for increased stakes (%) */
const HIGH_ROI_THRESHOLD = 10;

/** ROI threshold for long-lived bet notifications (%) */
const LONG_LIVED_ROI_THRESHOLD = 15;

/** Long-lived bet time threshold for LIVE (seconds) */
const LONG_LIVED_LIVE_SECONDS = 7;

/** Long-lived bet time threshold for PREMATCH (seconds) */
const LONG_LIVED_PREMATCH_SECONDS = 60;

/** Default stake amount (EUR) */
const DEFAULT_STAKE = 0.50;

/** Minimum allowed odds (default for bookmaker) */
const MIN_ODDS = 1.10;

/** Maximum allowed odds (default for bookmaker) */
const MAX_ODDS = 4.00;

/** Maximum bets per match */
const MAX_BETS_PER_MATCH = 4;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  ⛔ ЗАПРЕЩЕНО УВЕЛИЧИВАТЬ ЭТО ЗНАЧЕНИЕ!                       ║
 * ║  КРИТИЧНО: ДОПУСК КОЭФФИЦИЕНТА = 0.01 - НЕ МЕНЯТЬ!            ║
 * ║  Может показаться что 0.02-0.03 увеличит конверсию,          ║
 * ║  но это приведёт к ставкам по невыгодным коэффициентам!      ║
 * ║  Value рассчитан на точный коэфф - любое отклонение = убыток ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
const ODDS_TOLERANCE = 0.01;

/** Maximum outcome switches per bet attempt */
const MAX_SWITCHES = 3;

/** Odds convergence timeout — LIVE (ms).
 * When bookmaker odds don't match analyzer, wait for analyzer to update.
 * Each analyzer poll, re-check bookmaker odds vs fresh analyzer odds.
 */
const ODDS_CONVERGENCE_LIVE_MS = 20000;

/** Odds convergence timeout — PREMATCH (ms). */
const ODDS_CONVERGENCE_PREMATCH_MS = 90000;

// ==================== PROTECTION ====================

/** Block duration after failures (minutes) */
const BLOCK_DURATION_MINUTES = 15;

/** Max failed attempts before blocking outcome */
const MAX_FAILED_ATTEMPTS = 3;

/** Match block duration after repeated failures (minutes) */
const MATCH_BLOCK_DURATION_MINUTES = 30;

/** Bet history retention (hours) — must cover prematch horizon + safety margin */
const HISTORY_RETENTION_HOURS = 48;

// ==================== HEALTH SERVER ====================

/** Default health server port */
const DEFAULT_HEALTH_PORT = 9999;

// ==================== PINNACLE ODDS FILTER ====================

/** Default min odds for Pinnacle filter (configurable per bookmaker) */
const PINNACLE_MIN_ODDS = 1.10;

/** Default max odds for Pinnacle filter (configurable per bookmaker) */
const PINNACLE_MAX_ODDS = 4.00;

// ==================== ANALYZER ====================

/** Default analyzer URL */
const DEFAULT_ANALYZER_URL = 'http://localhost:7005/pairs';

/** Prematch analyzer URL */
const PREMATCH_ANALYZER_URL = 'http://localhost:7006/pairs';

// ==================== EXPORTS ====================

module.exports = {
    // Timing
    POLL_INTERVAL_MS,
    SESSION_CHECK_INTERVAL_MS,
    SESSION_CACHE_TTL_MS,
    STATE_MAX_AGE_MS,
    HTTP_TIMEOUT_MS,
    POST_BET_DELAY_MS,
    FRESH_DATA_TIMEOUT_MS,
    BALANCE_PAUSE_MINUTES,
    
    // Stability
    FAST_DURATION_SECONDS,
    SLOW_DURATION_SECONDS,
    SINGLE_DURATION_SECONDS,
    MIN_UPDATES_FOR_STABILITY,
    TRACKER_MAX_AGE_MS,
    
    // Betting limits
    MIN_ROI,
    MAX_ROI,
    HIGH_ROI_THRESHOLD,
    LONG_LIVED_ROI_THRESHOLD,
    LONG_LIVED_LIVE_SECONDS,
    LONG_LIVED_PREMATCH_SECONDS,
    DEFAULT_STAKE,
    MIN_ODDS,
    MAX_ODDS,
    MAX_BETS_PER_MATCH,
    ODDS_TOLERANCE,
    MAX_SWITCHES,
    ODDS_CONVERGENCE_LIVE_MS,
    ODDS_CONVERGENCE_PREMATCH_MS,
    
    // Protection
    BLOCK_DURATION_MINUTES,
    MAX_FAILED_ATTEMPTS,
    MATCH_BLOCK_DURATION_MINUTES,
    HISTORY_RETENTION_HOURS,
    
    // Health
    DEFAULT_HEALTH_PORT,
    
    // Pinnacle odds filter
    PINNACLE_MIN_ODDS,
    PINNACLE_MAX_ODDS,
    
    // Analyzer
    DEFAULT_ANALYZER_URL,
    PREMATCH_ANALYZER_URL
};
