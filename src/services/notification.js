const Notification = require('../models/Notification');

const createNotification = async (userId, icon, title, message, type = 'shipping', shipmentId = '', actionType = '') => {
  try {
    const notification = new Notification({
      userId,
      icon,
      title,
      message,
      type,
      shipmentId,
      actionType
    });
    await notification.save();
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};

module.exports = { createNotification };
