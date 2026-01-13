const cron = require("node-cron");
const { autoExpireDemoNoShows } = require("../../controllers/bookingController");

const runOnce = async () => {
  try {
    const res = await autoExpireDemoNoShows();
    if (res?.expired) {
      console.log(`[demo-no-show] expired ${res.expired}/${res.checked}`);
    }
  } catch (err) {
    console.error("Demo no-show scheduler failed:", err.message);
  }
};

module.exports = {
  start() {
    cron.schedule("*/5 * * * *", runOnce);
  },
  runOnce,
};
