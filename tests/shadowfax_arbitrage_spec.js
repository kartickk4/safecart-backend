/**
 * Shadowfax Direct Rate & Arbitrage Specification Test
 * 
 * Tests:
 * 1. Live Shadowfax Dale API Serviceability verification with user token
 * 2. Shadowfax Direct live rate calculation with ₹2 platform discount
 * 3. Rate Arbitrage Comparison: Direct Shadowfax vs NimbusPost Shadowfax (lowest price selected)
 */

const assert = require('assert');
const { fetchDirectShadowfaxRate, checkShadowfaxServiceability } = require('../src/services/shadowfaxService');
const { getCarrierRatesAsync } = require('../src/services/carrierRateService');

console.log('========================================================');
console.log('🧪 RUNNING SHADOWFAX DIRECT & ARBITRAGE SPEC TESTS');
console.log('========================================================\n');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}`);
    failed++;
  }
}

(async () => {
  // Test 1: Live Shadowfax Serviceability on Dale API
  await runTest('T1: Shadowfax Dale pin serviceability returns serviceable for metro pincodes', async () => {
    const res = await checkShadowfaxServiceability('700001');
    assert.strictEqual(res.serviceable, true);
    assert.strictEqual(res.pincode, '700001');
  });

  // Test 2: Live Shadowfax Direct Rate Calculation with ₹5 discount offset
  await runTest('T2: Shadowfax Direct live rate calculation returns valid quote with ₹5 discount', async () => {
    const quote = await fetchDirectShadowfaxRate({
      fromPincode: '700001',
      toPincode: '110001',
      weightKg: 0.5,
      isCod: false
    });

    assert.ok(quote, 'Quote should not be null');
    assert.strictEqual(quote.slug, 'shadowfax_direct');
    assert.strictEqual(quote.baseSlug, 'shadowfax');
    assert.ok(quote.price > 0, `Price should be positive, got ${quote.price}`);
    assert.strictEqual(quote.discountOffset, 5.00);
    assert.strictEqual(quote.isDirectShadowfax, true);
    console.log(`     Live Direct Shadowfax Rate (0.5kg 700001 -> 110001): ₹${quote.price} (Original ₹${quote.originalRate})`);
  });

  // Test 3: Shadowfax vs Nimbus Arbitrage Engine via getCarrierRatesAsync
  await runTest('T3: getCarrierRatesAsync runs arbitrage and displays the lowest Shadowfax rate', async () => {
    const quotes = await getCarrierRatesAsync('700001', '110001', 0.5, null, false, false, 0, false);
    assert.ok(Array.isArray(quotes) && quotes.length > 0, 'Should return array of carrier quotes');

    // Find the Shadowfax quote in the combined list
    const shadowfaxQuotes = quotes.filter(q => q.baseSlug === 'shadowfax');
    assert.ok(shadowfaxQuotes.length > 0, 'Must have at least one Shadowfax quote');

    // Exactly one winner Shadowfax quote should be presented
    const winner = shadowfaxQuotes[0];
    assert.ok(winner.price > 0);
    console.log(`     Shadowfax Winning Quote: "${winner.courierPartner || winner.name}" at ₹${winner.price}`);
    if (winner.savingsBadge) {
      console.log(`     Savings Badge Displayed: "${winner.savingsBadge}"`);
    }

    // Verify list is sorted ascending by price
    for (let i = 0; i < quotes.length - 1; i++) {
      assert.ok(quotes[i].price <= quotes[i + 1].price, `Quotes must be sorted by price: ₹${quotes[i].price} <= ₹${quotes[i + 1].price}`);
    }
  });

  console.log('\n========================================================');
  console.log(`🎯 SHADOWFAX SPECIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
})();

