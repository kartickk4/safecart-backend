const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// Dynamic module loader (matches existing pattern in codebase)
function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(process.cwd(), 'src', type, name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  return require(`../${type}/${name}`);
}

const {
  handleChat,
  handleBulkUpload,
  confirmBulkBooking,
  getBulkStatus,
  downloadBulkReport,
  getCarrierRatesHandler,
  getSession
} = loadMod('controllers', 'agentController');

const { protect } = loadMod('middleware', 'auth');

// Multer — memory storage for Excel files (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed.'));
    }
  }
});

const router = express.Router();

// Chat — single shipment AI agent conversation turn
router.post('/chat', protect, handleChat);

// Bulk upload — parse & validate Excel file
router.post('/bulk-upload', protect, upload.single('file'), handleBulkUpload);

// Confirm bulk booking — start processing all valid rows
router.post('/bulk-confirm', protect, confirmBulkBooking);

// Poll bulk job status
router.get('/bulk-status/:jobId', protect, getBulkStatus);

// Download completed bulk booking report (.xlsx)
router.get('/bulk-report/:jobId', protect, downloadBulkReport);

// Carrier rate comparison (for carrier card in frontend)
router.post('/carrier-rates', protect, getCarrierRatesHandler);

// Restore session state for floating widget
router.get('/session/:sessionId', protect, getSession);

module.exports = router;
