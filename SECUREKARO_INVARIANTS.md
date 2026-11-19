# 🛡️ SecureKaro Engineering Invariants & AI Guardrails

> **Mandatory Guidelines for AI Agents & Developers working on SecureKaro / SafeCart.**  
> Derived from real production incidents and Karpathy/WCC engineering directives.

---

## 1. 🛑 Zero-Crash AST Invariant (Frontend)
- **Every identifier, icon, component, and utility MUST be explicitly imported.**
- Never reference `<LucideIcon />`, `createPortal`, or helper functions without confirming their import at the top of the file.
- **Verification Rule:** Before committing or deploying any frontend change, run:
  ```bash
  npm run verify
  ```
  This executes Babel AST static analysis across all 64 source components. It must exit with `0 undeclared references`.

---

## 2. 📱 Mobile Viewport & Modal Stacking Contexts
- In mobile viewports (`phone view`), all full-screen modals, slide-overs, and bottom sheets (e.g. `BulkUploadPanel`, `TaxStatementModal`, `WalletModal`) **MUST use `createPortal(..., document.body)`**.
- **Reason:** Parent view containers have CSS `.view-enter` with `transform: translateY(8px)`. Stacking contexts trap `position: fixed` elements and clip or hide them offscreen on mobile devices.
- Containers with expandable accordions or radio choices must use `overflow-visible` and appropriate dynamic heights (`max-h-[1400px]`) to avoid cutting off payment buttons.

---

## 3. 💰 Financial & Escrow Balance Invariants (Backend)
- **Atomic Operations Only:** NEVER perform read-then-write on wallet balances (e.g. `user.walletBalance -= amount; await user.save()`).
- Always use `User.findOneAndUpdate` with atomic conditions:
  ```javascript
  await User.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: requestedAmount + securityReserve } },
    { $inc: { walletBalance: -requestedAmount } },
    { new: true }
  );
  ```
- **Security Reserve Rule:** Sellers must maintain a minimum security buffer of **₹100 per active shipment**, capped at **₹1,000 max**. This cannot be bypassed unless `isDeductFromSettlement` is selected on COD shipments.
- **Idempotency Guard:** All financial transactions must enforce a unique sparse index on `idempotencyKey` to prevent double-clicks or duplicate webhook deliveries.

---

## 4. 💳 Payment Gateway & Webhook Security
- **No Gateway Fallthrough:** In `publicPayShipment`, never assume payment succeeded. Always verify with PhonePe (`getPaymentStatus`). If the status check throws or fails, return `502 / 400`—never fall through to courier booking.
- **Signature Verification:** Always cryptographically verify incoming PhonePe `X-Verify` signatures before parsing webhook payloads.

---

## 5. 🇮🇳 DPDP Act, 2023 Statutory Compliance
- **Non-Automated, Granular Consent:** Checkboxes must start **unticked** (`useState(false)`). Pre-ticking is strictly prohibited.
- **Itemized Purposes:**
  1. Age confirmation (18+) & legal policy agreement.
  2. Purpose-specific logistics & escrow data processing.
  - **Evidentiary Timestamps:** All user registrations must record `agreedAt`, `is18Plus`, `ipAddress`, and `userAgent` in `consentRecord`.
- **Public Masking:** Public tracking endpoints (`GET /api/v1/tracking/:awb`) must never return receiver name, phone, or home address—only city and carrier milestones.
- **Right to Erasure:** `DELETE /api/v1/profile/account` must scrub all PII while verifying no shipments are in transit and wallet balance is cleared.

---

## 6. ✂️ Surgical Changes Only
- Touch **only** the lines or functions required for the specific task.
- Do not randomly reformat, reorder, or rewrite adjacent code in large files (`shipmentController.js`, `AdminView.jsx`).
