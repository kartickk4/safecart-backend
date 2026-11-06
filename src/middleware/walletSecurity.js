const rateLimit = require('express-rate-limit');
const WalletTransaction = require('../models/WalletTransaction');

// ── 1. Financial Rate Limiters (Anti-DDoS, Brute-Force & Flood Guard) ────────

// Max 5 withdrawal requests per 15 minutes per IP/User
const withdrawalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return (req.user?._id ? req.user._id.toString() : req.ip) + '_withdraw';
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many withdrawal attempts. For banking security, please wait 15 minutes before submitting another request.',
      rateLimitReached: true
    });
  }
});

// Max 10 recharge creations per 15 minutes per IP/User
const rechargeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return (req.user?._id ? req.user._id.toString() : req.ip) + '_recharge';
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many recharge requests. Please wait a few minutes before creating a new order.',
      rateLimitReached: true
    });
  }
});

// ── 2. Payout Destination Cooling-Off Period (Anti-Account-Takeover) ─────────
// Banking standard: When a UPI ID or Bank Account is newly changed, lock
// payouts to that new destination for 2 hours to prevent attacker account drain.
const COOLING_OFF_HOURS = 2;
const COOLING_OFF_MS = COOLING_OFF_HOURS * 60 * 60 * 1000;

const checkCoolingPeriod = (user, requestedDestination = '') => {
  if (!user || !user.payoutDetailsUpdatedAt) return { locked: false };

  const updatedAt = new Date(user.payoutDetailsUpdatedAt).getTime();
  const elapsedMs = Date.now() - updatedAt;

  if (elapsedMs < COOLING_OFF_MS) {
    const remainingMs = COOLING_OFF_MS - elapsedMs;
    const remainingMins = Math.ceil(remainingMs / (60 * 1000));
    return {
      locked: true,
      remainingMinutes: remainingMins,
      unlocksAt: new Date(Date.now() + remainingMs).toISOString(),
      message: `SECURITY_COOLING_PERIOD: Your payout destination was updated recently. For financial protection against unauthorized access, withdrawals are temporarily locked for a 2-hour security cooling period. Available in ${remainingMins} minute(s).`
    };
  }

  return { locked: false };
};

// ── 3. Velocity Checks & Platform Circuit Breaker ───────────────────────────
const USER_DAILY_LIMIT = 50000;              // ₹50,000 max per user in 24h
const PLATFORM_DAILY_CIRCUIT_BREAKER = 200000; // ₹2,00,000 max platform total in 24h
const HIGH_VALUE_APPROVAL_THRESHOLD = 10000;  // > ₹10,000 flagged for admin approval

const checkWithdrawalVelocity = async (userId, requestedAmount) => {
  const numRequested = parseFloat(requestedAmount);
  if (isNaN(numRequested) || numRequested <= 0) {
    throw new Error('Invalid withdrawal amount');
  }

  const rolling24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Parallel user and platform velocity aggregation
  const [userAgg, platformAgg] = await Promise.all([
    WalletTransaction.aggregate([
      {
        $match: {
          $or: [{ userId }, { sellerId: userId }],
          type: 'debit',
          source: 'withdrawal',
          status: { $in: ['success', 'pending'] },
          createdAt: { $gte: rolling24h }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    WalletTransaction.aggregate([
      {
        $match: {
          type: 'debit',
          source: 'withdrawal',
          status: { $in: ['success', 'pending'] },
          createdAt: { $gte: rolling24h }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);

  const userSpent24h = userAgg[0]?.total || 0;
  const platformSpent24h = platformAgg[0]?.total || 0;

  // 1. Check User Daily Limit
  if (userSpent24h + numRequested > USER_DAILY_LIMIT) {
    const remaining = Math.max(0, USER_DAILY_LIMIT - userSpent24h);
    return {
      allowed: false,
      reason: `Daily withdrawal limit of ₹${USER_DAILY_LIMIT.toLocaleString('en-IN')} exceeded. You have withdrawn ₹${userSpent24h.toLocaleString('en-IN')} in the last 24 hours. Remaining limit today: ₹${remaining.toLocaleString('en-IN')}.`,
      userSpent24h,
      limit: USER_DAILY_LIMIT
    };
  }

  // 2. Check Platform Circuit Breaker
  if (platformSpent24h + numRequested > PLATFORM_DAILY_CIRCUIT_BREAKER) {
    console.error(`[SECURITY ALERT] Platform daily payout circuit breaker tripped! 24h total: ₹${platformSpent24h}`);
    return {
      allowed: false,
      circuitBreakerTripped: true,
      reason: 'Automated platform payouts have reached today\'s safety threshold. Your request has been queued for security verification.'
    };
  }

  // 3. High Value Flagging
  const requiresAdminApproval = numRequested > HIGH_VALUE_APPROVAL_THRESHOLD;

  return {
    allowed: true,
    requiresAdminApproval,
    userSpent24h,
    platformSpent24h
  };
};

module.exports = {
  withdrawalRateLimiter,
  rechargeRateLimiter,
  checkCoolingPeriod,
  checkWithdrawalVelocity,
  USER_DAILY_LIMIT,
  PLATFORM_DAILY_CIRCUIT_BREAKER,
  HIGH_VALUE_APPROVAL_THRESHOLD
};
