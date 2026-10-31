/**
 * Delhivery Direct Rate & Arbitrage Specification Test
 * 
 * Tests:
 * 1. Live Delhivery Invoice Charges API calculation with user's active token
 * 2. Delhivery Pin Serviceability verification
 * 3. Rate Arbitrage Comparison: Direct Delhivery vs NimbusPost Delhivery (min price selection)
 */

const assert = require('assert');
const { fetchDirectDelhiveryRate, checkDelhiveryServiceability } = require('../src/services/delhiveryService');
const { getCarrierRatesAsync } = require('../src/services/carrierRateService');

console.log('========================================================');
console.log('🧪 RUNNING DELHIVERY DIRECT & ARBITRAGE SPEC TESTS');
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
  // Test 1: Live Delhivery Serviceability
  await runTest('T1: Delhivery pin serviceability returns serviceable for metro pincodes', async () => {
    const res = await checkDelhiveryServiceability('110001');
    assert.strictEqual(res.serviceable, true);
    assert.strictEqual(res.pin, 110001);
  });

  // Test 2: Live Delhivery Direct Rate Calculation
  await runTest('T2: Delhivery Direct live rate calculation returns valid quote with ₹2 discount', async () => {
    const quote = await fetchDirectDelhiveryRate({
      fromPincode: '700001',
      toPincode: '110001',
      weightKg: 0.5,
      isCod: false
    });

    assert.ok(quote, 'Quote should not be null');
    assert.strictEqual(quote.slug, 'delhivery_direct');
    assert.strictEqual(quote.baseSlug, 'delhivery');
    assert.ok(quote.price > 0, `Price should be positive, got ${quote.price}`);
    assert.strictEqual(quote.discountOffset, 2.00);
    assert.strictEqual(quote.isDirectDelhivery, true);
    console.log(`     Live Direct Delhivery Rate (0.5kg 700001 -> 110001): ₹${quote.price} (Original ₹${quote.originalRate})`);
  });

  // Test 3: Delhivery vs Nimbus Arbitrage Engine via getCarrierRatesAsync
  await runTest('T3: getCarrierRatesAsync runs arbitrage and displays the lowest Delhivery rate', async () => {
    const quotes = await getCarrierRatesAsync('700001', '110001', 0.5, null, false, false, 0, false);
    assert.ok(Array.isArray(quotes) && quotes.length > 0, 'Should return array of carrier quotes');

    // Find the Delhivery quote in the combined list
    const delhiveryQuotes = quotes.filter(q => q.baseSlug === 'delhivery');
    assert.ok(delhiveryQuotes.length > 0, 'Must have at least one Delhivery quote');

    // Exactly one winner Delhivery quote should be presented
    const winner = delhiveryQuotes[0];
    assert.ok(winner.price > 0);
    console.log(`     Delhivery Winning Quote: "${winner.courierPartner || winner.name}" at ₹${winner.price}`);
    if (winner.savingsBadge) {
      console.log(`     Savings Badge Displayed: "${winner.savingsBadge}"`);
    }

    // Verify list is sorted ascending by price
    for (let i = 0; i < quotes.length - 1; i++) {
      assert.ok(quotes[i].price <= quotes[i + 1].price, `Quotes must be sorted by price: ₹${quotes[i].price} <= ₹${quotes[i + 1].price}`);
    }
  });

  console.log('\n========================================================');
  console.log(`🎯 DELHIVERY SPECIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
})();
