/**
 * Consensus FX Sentinel - provider request budget.
 *
 * One scan costs `1 + timeframes * instruments` requests: a single batched
 * top-of-book call plus four historical candle calls per instrument. That is 17
 * requests for the four default instruments, and 97 for all twenty-four.
 *
 * Tiingo's documented free tier allows 50 requests/hour and 1,000/day, so the
 * cost of activating instruments is not linear in usefulness - it is a hard
 * wall. Enabling all twenty-four at any cadence would exceed the hourly
 * allowance with a SINGLE scan.
 *
 * This module makes that arithmetic explicit and checkable BEFORE the runtime
 * opens a socket, polls Telegram or writes state. An invalid configuration must
 * fail loudly rather than silently slowing the requested cadence or quietly
 * dropping instruments, either of which would corrupt a forward trial without
 * anyone noticing.
 *
 * Pure. No I/O, no credentials.
 */

"use strict";

/** Documented Tiingo free-tier limits. Overridable for a paid plan. */
const FREE_TIER = Object.freeze({
  hourly: 50,
  daily: 1000,
});

/**
 * Small buffer for provider timing and retry boundaries. Interactive `/scan`
 * requests are cadence-limited by the scanner and replace, rather than add to,
 * the next scheduled provider pass.
 */
const RESERVE = Object.freeze({
  hourly: 5,
  daily: 50,
});

const TIMEFRAMES_PER_SCAN = 4; // M1, M5, M15, H1
const QUOTE_REQUESTS_PER_SCAN = 1; // one batched top-of-book call

/** Requests consumed by a single scan of `instrumentCount` instruments. */
function requestsPerScan(instrumentCount, timeframes = TIMEFRAMES_PER_SCAN) {
  return QUOTE_REQUESTS_PER_SCAN + timeframes * Math.max(0, instrumentCount);
}

/**
 * Project usage for a configuration.
 *
 * `scansPerHour` is deliberately not rounded down: a 25-minute interval really
 * does produce bursts of nearly three scans in some hours.
 */
function estimate({ instrumentCount, scanIntervalSeconds, limits = FREE_TIER, reserve = RESERVE }) {
  const perScan = requestsPerScan(instrumentCount);
  const interval = Number(scanIntervalSeconds);
  const scansPerHour = interval > 0 ? 3600 / interval : Infinity;
  const hourly = perScan * scansPerHour;
  const daily = hourly * 24;

  return {
    instrumentCount,
    scanIntervalSeconds: interval,
    requestsPerScan: perScan,
    scansPerHour,
    hourlyRequests: hourly,
    dailyRequests: daily,
    limits: { hourly: limits.hourly, daily: limits.daily },
    reserve: { hourly: reserve.hourly, daily: reserve.daily },
    hourlyHeadroom: limits.hourly - reserve.hourly - hourly,
    dailyHeadroom: limits.daily - reserve.daily - daily,
  };
}

/**
 * Validate a configuration against the budget.
 *
 * Three independent checks, because they fail for different reasons:
 *
 *  1. burst  - one scan alone must fit inside one hour's allowance. Fails first
 *              because no cadence can rescue it.
 *  2. hourly - sustained usage plus the diagnostic reserve.
 *  3. daily  - sustained usage over a full day.
 */
function validate(input) {
  const projection = estimate(input);
  const problems = [];

  const burstBudget = projection.limits.hourly - projection.reserve.hourly;
  if (projection.requestsPerScan > burstBudget) {
    problems.push(
      `one scan of ${projection.instrumentCount} instrument(s) needs `
      + `${projection.requestsPerScan} requests, which alone exceeds the `
      + `${projection.limits.hourly}/hour limit less a ${projection.reserve.hourly}-request reserve. `
      + `Reduce FX_SYMBOLS or raise the hourly limit.`,
    );
  }
  if (projection.hourlyRequests > burstBudget) {
    problems.push(
      `sustained usage is ${Math.ceil(projection.hourlyRequests)} requests/hour `
      + `(${projection.requestsPerScan} per scan every ${projection.scanIntervalSeconds}s), `
      + `over the ${projection.limits.hourly}/hour limit less a ${projection.reserve.hourly}-request reserve. `
      + `Increase FX_SCAN_INTERVAL_SECONDS or reduce FX_SYMBOLS.`,
    );
  }
  const dailyBudget = projection.limits.daily - projection.reserve.daily;
  if (projection.dailyRequests > dailyBudget) {
    problems.push(
      `sustained usage is ${Math.ceil(projection.dailyRequests)} requests/day, `
      + `over the ${projection.limits.daily}/day limit less a ${projection.reserve.daily}-request reserve. `
      + `Increase FX_SCAN_INTERVAL_SECONDS or reduce FX_SYMBOLS.`,
    );
  }

  return { ok: problems.length === 0, projection, problems };
}

/** Human-readable one-liner for `/status` and dry-run output. */
function describe(projection) {
  return `${projection.requestsPerScan} requests/scan, `
    + `${Math.ceil(projection.hourlyRequests)}/hour, `
    + `${Math.ceil(projection.dailyRequests)}/day `
    + `(limits ${projection.limits.hourly}/hour, ${projection.limits.daily}/day)`;
}

module.exports = {
  FREE_TIER,
  QUOTE_REQUESTS_PER_SCAN,
  RESERVE,
  TIMEFRAMES_PER_SCAN,
  describe,
  estimate,
  requestsPerScan,
  validate,
};
