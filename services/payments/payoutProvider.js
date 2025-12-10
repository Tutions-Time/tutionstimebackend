const axios = require("axios");

function client() {
  const key = process.env.RAZORPAYX_KEY_ID;
  const secret = process.env.RAZORPAYX_KEY_SECRET;
  return axios.create({
    baseURL: "https://api.razorpay.com/v1",
    auth: { username: key, password: secret },
    timeout: 15000,
  });
}

async function ensureContactAndFundAccount(tutor) {
  const api = client();
  let contactId = tutor.razorpayxContactId;
  let fundAccountId = tutor.razorpayxFundAccountId;

  if (!contactId) {
    const res = await api.post("/contacts", {
      name: tutor.name || "Tutor",
      email: tutor.email || undefined,
      contact: undefined,
      type: "employee",
      reference_id: String(tutor._id),
    });
    contactId = res.data && res.data.id;
  }

  const useUPI = !!(tutor.upiId && tutor.upiId.trim());
  if (!fundAccountId) {
    if (useUPI) {
      const res = await api.post("/fund_accounts", {
        contact_id: contactId,
        account_type: "vpa",
        vpa: { address: tutor.upiId.trim() },
      });
      fundAccountId = res.data && res.data.id;
    } else {
      const res = await api.post("/fund_accounts", {
        contact_id: contactId,
        account_type: "bank_account",
        bank_account: {
          name: tutor.accountHolderName,
          ifsc: tutor.ifsc,
          account_number: tutor.bankAccountNumber,
        },
      });
      fundAccountId = res.data && res.data.id;
    }
  }

  return { contactId, fundAccountId, useUPI };
}

async function createPayout(fundAccountId, amountInRupees, mode, referenceId) {
  const api = client();
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER; 
  const amt = Math.round(Number(amountInRupees) * 100);
  const res = await api.post("/payouts", {
    account_number: accountNumber,
    fund_account_id: fundAccountId,
    amount: amt,
    currency: "INR",
    mode,
    purpose: "payout",
    queue_if_low_balance: true,
    reference_id: referenceId || undefined,
    narration: "Tutor payout",
  });
  return res.data;
}

module.exports = { ensureContactAndFundAccount, createPayout };

