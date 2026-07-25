const path = require('path');
const fs = require('fs');

function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(__dirname, type, name),
    path.resolve(__dirname, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch(e) {}
  try { return require(`./${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const User = loadMod('models', 'User');

/**
 * @desc    Get current user profile details
 * @route   GET /api/v1/profile
 * @access  Private
 */
const getProfile = async (req, res) => {
  try {
    // req.user has already been populated by protect middleware
    res.json(req.user);
  } catch (error) {
    console.error('Get Profile Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Update user profile or payout bank details
 * @route   PUT /api/v1/profile
 * @access  Private
 */
const updateProfile = async (req, res) => {
  const { fullName, avatarUrl, bankDetails } = req.body;

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update basic fields if provided
    if (fullName) user.fullName = fullName;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

    // Update bank details if provided
    if (bankDetails) {
      user.bankDetails = {
        accountHolderName: bankDetails.accountHolderName || user.bankDetails.accountHolderName,
        accountNumber: bankDetails.accountNumber || user.bankDetails.accountNumber,
        ifscCode: bankDetails.ifscCode || user.bankDetails.ifscCode,
        bankName: bankDetails.bankName || user.bankDetails.bankName
      };
    }

    const updatedUser = await user.save();

    // Exclude password hash from response
    const userResponse = updatedUser.toObject();
    delete userResponse.passwordHash;

    res.json(userResponse);
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getProfile,
  updateProfile
};
