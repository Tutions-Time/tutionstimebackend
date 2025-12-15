const { TUTOR_RELEASE_DELAY_VALUE, TUTOR_RELEASE_DELAY_UNIT } = process.env;

function getDelayMs() {
  const valRaw = Number(TUTOR_RELEASE_DELAY_VALUE);
  const value = Number.isFinite(valRaw) && valRaw > 0 ? valRaw : 30; // Production default → 30 days
  const unit = String(TUTOR_RELEASE_DELAY_UNIT || "days").toLowerCase();
  let multiplier = 24 * 60 * 60 * 1000;
  if (unit === "minutes") multiplier = 60 * 1000; // Testing example → 2 minutes
  else if (unit === "hours") multiplier = 60 * 60 * 1000;
  else if (unit === "days") multiplier = 24 * 60 * 60 * 1000;
  else multiplier = 24 * 60 * 60 * 1000; // fallback to days
  return value * multiplier;
}

function getReleaseAt(baseDate = new Date()) {
  const ms = getDelayMs();
  return new Date(baseDate.getTime() + ms);
}

module.exports = { getReleaseAt, getDelayMs: getDelayMs };

