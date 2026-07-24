const Notification = require('../models/Notification');

const createNotification = async (userId, icon, title, message, type = 'shipping') => {
  try {
    const notification = new Notification({
      userId,
      icon,
      title,
      message,
      type
    });
    await notification.save();
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};

module.exports = { createNotification };
