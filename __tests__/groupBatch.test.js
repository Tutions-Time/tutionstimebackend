process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret';
const controller = require('../controllers/groupBatchController');

describe('GroupBatch feature flag', () => {
  test('returns 404 when disabled', async () => {
    if (String(process.env.FEATURE_GROUP_BATCHES || 'false').toLowerCase() === 'true') {
      return; // skip when enabled
    }
    const req = { query: {}, user: { id: 'u' } };
    const res = { statusCode: 200, jsonPayload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.jsonPayload = payload; return this; } };
    await controller.listBatches(req, res);
    expect(res.statusCode).toBe(404);
  });
});

// Note: full integration tests require a configured MongoDB and auth token.
// Additional tests should be added in staging with real DB for reservation and idempotency flows.
