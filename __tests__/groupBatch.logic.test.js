process.env.FEATURE_GROUP_BATCHES = 'true';
const controller = require('../controllers/groupBatchController');
const paymentController = require('../controllers/paymentController');

describe('GroupBatch join reservation', () => {
  test.skip('reserves seat when capacity allows', async () => {
    const now = new Date();
    const StudentProfile = require('../models/StudentProfile');
    jest.spyOn(StudentProfile, 'findOne').mockReturnValue({ select: () => ({ _id: 'sp1' }) });

    const GroupBatch = require('../models/GroupBatch');
    jest.spyOn(GroupBatch, 'findOneAndUpdate').mockResolvedValue({ _id: 'gb1', holds: [{ studentId: 'sp1', expiresAt: new Date(now.getTime()+60000), status: 'active' }], enrolled: [], seatCap: 5 });

    const adminNotif = require('../services/adminNotification');
    jest.spyOn(adminNotif, 'createAdminNotification').mockResolvedValue(undefined);

    const req = { params: { id: 'gb1' }, user: { id: 'u1' } };
    const res = { statusCode: 200, body: null, status(code){ this.statusCode=code; return this; }, json(payload){ this.body=payload; return this; } };
    await controller.joinBatch(req,res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Group payment idempotency', () => {
  test('verifyGroupPayment is idempotent', async () => {
    const Payment = require('../models/Payment');
    jest.spyOn(Payment, 'findOne').mockResolvedValue({ _id:'p1', status:'paid' });
    const StudentProfile = require('../models/StudentProfile');
    jest.spyOn(StudentProfile, 'findOne').mockReturnValue({ select: () => ({ _id: 'sp1' }) });
    const req = { body: { orderId:'o', paymentId:'p', signature:'s', batchId:'gb1' }, user: { id:'u1' } };
    const res = { statusCode: 200, body: null, status(code){ this.statusCode=code; return this; }, json(payload){ this.body=payload; return this; } };
    // mock signature validation
    process.env.RAZORPAY_KEY_SECRET = 'x';
    const crypto = require('crypto');
    jest.spyOn(crypto, 'createHmac').mockReturnValue({ update: () => ({ digest: () => 's' }) });
    await paymentController.verifyGroupPayment(req,res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
