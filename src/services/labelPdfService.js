/**
 * labelPdfService.js
 * Generates standard 4x6 inch (288pt x 432pt) thermal shipping labels in pure PDF format
 * using PDFKit. Runs directly on Render Node.js backend with zero external dependencies.
 */

const PDFDocument = require('pdfkit');

/**
 * Generate binary 4x6 thermal label PDF stream
 * @param {Object} shipment - Populated Shipment document
 * @param {Object} res - Express response stream
 */
function streamShippingLabelPdf(shipment, res) {
  // 4 inches = 288 points, 6 inches = 432 points
  const doc = new PDFDocument({
    size: [288, 432],
    margins: { top: 10, bottom: 10, left: 12, right: 12 }
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="shipping-label-${shipment.shipmentId}.pdf"`);

  doc.pipe(res);

  const sender = shipment.senderId || {};
  const senderName = sender.businessName || sender.fullName || 'SecureKaro Merchant';
  const senderPhone = sender.phone || '';
  const senderAddr = sender.address || 'Merchant Warehouse';
  const senderPin = sender.pincode || '110001';

  const isCod = shipment.paymentMode === 'cod';
  const carrier = (shipment.carrierSlug || 'delhivery').toUpperCase();
  const awb = shipment.awbCode || shipment.trackingId || shipment.shipmentId;
  const weight = shipment.parcelWeight ? Number(shipment.parcelWeight).toFixed(2) : '0.50';

  // 1. TOP HEADER: Brand & Carrier
  doc.rect(12, 10, 264, 28).stroke('#000000');
  doc.fontSize(11).font('Helvetica-Bold').text('SECUREKARO LOGISTICS', 18, 18);
  doc.fontSize(11).font('Helvetica-Bold').text(carrier, 210, 18, { align: 'right', width: 60 });

  // 2. AWB & BARCODE SIMULATION
  doc.rect(12, 42, 264, 46).stroke('#000000');
  doc.fontSize(16).font('Courier-Bold').text('||||| |||| |||||| ||||| ||||', 12, 50, { align: 'center', width: 264 });
  doc.fontSize(9).font('Helvetica-Bold').text(`AWB: ${awb}`, 12, 72, { align: 'center', width: 264 });

  // 3. PAYMENT BANNER (COD vs PREPAID)
  if (isCod) {
    doc.rect(12, 92, 264, 24).fillAndStroke('#000000', '#000000');
    doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
      .text(`CASH ON DELIVERY (COD): ₹${shipment.amount || 0}`, 12, 99, { align: 'center', width: 264 });
    doc.fillColor('#000000');
  } else {
    doc.rect(12, 92, 264, 24).stroke('#000000');
    doc.fontSize(11).font('Helvetica-Bold')
      .text('PREPAID — DO NOT COLLECT CASH', 12, 99, { align: 'center', width: 264 });
  }

  // 4. SHIP TO (BUYER DETAILS)
  doc.rect(12, 120, 264, 130).stroke('#000000');
  doc.fontSize(8).font('Helvetica-Bold').text('DELIVER TO (RECIPIENT):', 18, 126);
  doc.fontSize(12).font('Helvetica-Bold').text(shipment.receiverName || 'Recipient', 18, 138, { width: 250 });
  doc.fontSize(10).font('Helvetica-Bold').text(`Phone: ${shipment.receiverPhone || ''}`, 18, 154);
  
  doc.fontSize(9).font('Helvetica').text(shipment.receiverAddress || '', 18, 168, { width: 250, height: 48 });
  
  // PIN CODE BOX
  doc.rect(18, 222, 110, 20).stroke('#000000');
  doc.fontSize(11).font('Helvetica-Bold').text(`PIN: ${shipment.receiverPincode || ''}`, 22, 227);

  // 5. SHIP FROM (RETURN / SELLER)
  doc.rect(12, 254, 264, 76).stroke('#000000');
  doc.fontSize(8).font('Helvetica-Bold').text('RETURN TO (SHIPPER):', 18, 260);
  doc.fontSize(10).font('Helvetica-Bold').text(senderName, 18, 272, { width: 250 });
  if (senderPhone) {
    doc.fontSize(8).font('Helvetica').text(`Phone: ${senderPhone}`, 18, 286);
  }
  doc.fontSize(8).font('Helvetica').text(`${senderAddr} - ${senderPin}`, 18, 298, { width: 250 });

  // 6. ORDER METADATA GRID
  doc.rect(12, 334, 264, 60).stroke('#000000');
  doc.fontSize(8).font('Helvetica-Bold').text(`Order ID: ${shipment.shipmentId}`, 18, 342);
  doc.fontSize(8).font('Helvetica').text(`Item: ${(shipment.description || 'General Parcel').slice(0, 32)}`, 18, 356);
  doc.fontSize(8).font('Helvetica').text(`Weight: ${weight} KG`, 18, 370);
  doc.fontSize(8).font('Helvetica-Bold').text(`Hub Route: ${shipment.receiverPincode ? shipment.receiverPincode.slice(0, 3) + ' HUB' : 'SURFACE'}`, 160, 342);
  doc.fontSize(8).font('Helvetica').text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 160, 356);

  // 7. FOOTER
  doc.fontSize(7).font('Helvetica').text('SecureKaro Escrow Shipping Protocol • securekaro.in/track', 12, 404, { align: 'center', width: 264 });

  doc.end();
}

module.exports = {
  streamShippingLabelPdf
};

