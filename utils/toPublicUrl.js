const path = require("path");

const toPublicUrl = (filePath) => {
  if (!filePath) return null;
  const index = filePath.lastIndexOf("uploads");
  if (index === -1) return null;
  return "/" + filePath.substring(index).replace(/\\/g, "/");
};

module.exports = toPublicUrl;
