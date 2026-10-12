const User = require('../models/User');
const Reward = require('../models/Reward');
const rewardService = require('../services/rewardService');

/**
 * @desc    Get user's cashback balance & reward history
 * @route   GET /api/v1/rewards/wallet
 * @access  Private
 */
const getRewardWallet = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const history = await Reward.find({ userId: req.user._id }).sort({ createdAt: -1 });
    const supplierWallet = await rewardService.computeSupplierWallet(req.user._id);

    const isSupplier = user.role === 'Supplier';
    // user.walletBalance holds credits from:
    //   - Accepted partial discount remainder (supplier gets principal - discountAmount)
    // These must be included in the withdrawable total.
    const directWalletCredits = parseFloat((Number(user.walletBalance) || 0).toFixed(2));

    const withdrawableBalance = supplierWallet
      ? parseFloat((supplierWallet.withdrawableBalance + directWalletCredits).toFixed(2))
      : (user.cashbackBalance || 0) + directWalletCredits;
    const pendingConfirmationBalance = supplierWallet ? supplierWallet.pendingConfirmationBalance : 0;
    const totalWalletBalance = supplierWallet
      ? parseFloat((supplierWallet.totalWalletBalance + directWalletCredits).toFixed(2))
      : (user.cashbackBalance || 0) + directWalletCredits;

    res.json({
      cashbackBalance: user.cashbackBalance || 0,
      walletBalance: directWalletCredits,
      withdrawableBalance,
      pendingConfirmationBalance,
      totalWalletBalance,
      confirmationPipeline: supplierWallet ? supplierWallet.confirmationPipeline : [],
      supplierWallet: supplierWallet || null,
      bankDetails: user.bankDetails || {},
      history: history || []
    });
  } catch (error) {
    console.error('Get Reward Wallet Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Request withdrawal of cashback balance to Bank or UPI
 * @route   POST /api/v1/rewards/withdraw
 * @access  Private
 */
const requestWithdrawal = async (req, res) => {
  try {
    const { amount, method, payoutDetails } = req.body;

    if (!amount || !method) {
      return res.status(400).json({ error: 'Please provide withdrawal amount and method (BANK or UPI)' });
    }

    const isMobileApp = Boolean(
      req.headers['x-client-platform'] === 'mobile-app' ||
      req.headers['x-request-source'] === 'mobile-app' ||
      req.body.isMobileApp === true
    );

    const result = await rewardService.withdrawCashback(
      req.user._id,
      amount,
      method,
      payoutDetails,
      isMobileApp
    );

    res.json({
      message: 'Withdrawal processed successfully',
      cashbackBalance: result.cashbackBalance,
      withdrawal: result.withdrawal
    });
  } catch (error) {
    console.error('Request Withdrawal Error:', error.message);
    const isAppDownloadRequired = error.message.includes('APP_DOWNLOAD_REQUIRED');
    const cleanError = error.message.replace('APP_DOWNLOAD_REQUIRED: ', '');

    res.status(isAppDownloadRequired ? 403 : 400).json({
      error: cleanError,
      appDownloadRequired: isAppDownloadRequired,
      downloadLinks: isAppDownloadRequired ? {
        android: 'https://play.google.com/store/apps/details?id=in.securekaro.app',
        ios: 'https://apps.apple.com/app/securekaro/id123456789'
      } : undefined
    });
  }
};

module.exports = {
  getRewardWallet,
  requestWithdrawal
};
