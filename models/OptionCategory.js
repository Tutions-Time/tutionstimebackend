const mongoose = require("mongoose");

const OptionCategorySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    options: {
      type: [String],
      default: [],
    },
    linkedTo: {
      type: String, 
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("OptionCategory", OptionCategorySchema);
