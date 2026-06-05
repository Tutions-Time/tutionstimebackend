const Coupon = require("../models/Coupon");

exports.createCoupon = async (req, res) => {
  try {
    const {
      code,
      type,
      value,
      maxRedemptions,
      perUserLimit,
      applicableTo,
      minAmount,
      validFrom,
      validTo,
      status,
      campaign,
    } = req.body;
    const coupon = await Coupon.create({
      code,
      type,
      value,
      maxRedemptions,
      perUserLimit,
      applicableTo,
      minAmount,
      validFrom,
      validTo,
      status,
      campaign,
    });
    res.json({ success: true, data: coupon });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.listCoupons = async (_req, res) => {
  const list = await Coupon.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: list });
};

exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json({ success: true, data: coupon });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.validateCoupon = async (req, res) => {
  try {
    const { code, type, amount } = req.body;
    const coupon = await Coupon.findOne({ code });
    if (!coupon || coupon.status !== "active") {
      return res.status(404).json({ success: false, message: "Invalid coupon" });
    }

    const now = new Date();
    if (
      (coupon.validFrom && now < coupon.validFrom) ||
      (coupon.validTo && now > coupon.validTo)
    ) {
      return res.status(400).json({ success: false, message: "Coupon expired" });
    }

    if (!coupon.applicableTo.includes(type)) {
      return res.status(400).json({ success: false, message: "Not applicable" });
    }

    if (amount < coupon.minAmount) {
      return res
        .status(400)
        .json({ success: false, message: "Amount below minimum" });
    }

    const discount =
      coupon.type === "percent"
        ? Math.floor((amount * coupon.value) / 100)
        : Math.min(coupon.value, amount);

    return res.json({
      success: true,
      data: { discount, finalAmount: amount - discount },
    });
  } catch (_err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
