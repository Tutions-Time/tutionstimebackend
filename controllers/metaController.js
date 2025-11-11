const OptionCategory = require("../models/OptionCategory");
const SubjectMapping = require("../models/SubjectMapping");

/* =============================
   OPTION CATEGORY CONTROLLERS
   ============================= */

// Create new category
exports.createCategory = async (req, res) => {
  try {
    const { key, label, options, linkedTo } = req.body;
    const exists = await OptionCategory.findOne({ key });
    if (exists)
      return res.status(400).json({ success: false, message: "Key already exists" });

    const category = await OptionCategory.create({
      key,
      label,
      options: options || [],
      linkedTo: linkedTo || null,
    });
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get all categories
exports.getCategories = async (req, res) => {
  try {
    const categories = await OptionCategory.find().sort({ createdAt: -1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get one category by ID
exports.getCategoryById = async (req, res) => {
  try {
    const category = await OptionCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Update category
exports.updateCategory = async (req, res) => {
  try {
    const { label, options, linkedTo, isActive } = req.body;
    const updated = await OptionCategory.findByIdAndUpdate(
      req.params.id,
      { label, options, linkedTo, isActive },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Delete category
exports.deleteCategory = async (req, res) => {
  try {
    const deleted = await OptionCategory.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =============================
   SUBJECT MAPPING CONTROLLERS
   ============================= */

// Create new subject mapping
exports.createSubjectMapping = async (req, res) => {
  try {
    const { track, category, categoryValue, subjects } = req.body;

    const mapping = await SubjectMapping.create({
      track,
      category,
      categoryValue,
      subjects,
    });

    res.status(201).json({ success: true, data: mapping });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get all mappings
exports.getSubjectMappings = async (req, res) => {
  try {
    const filter = {};
    if (req.query.track) filter.track = req.query.track;
    if (req.query.categoryValue) filter.categoryValue = req.query.categoryValue;
    const mappings = await SubjectMapping.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: mappings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get one mapping by ID
exports.getSubjectMappingById = async (req, res) => {
  try {
    const mapping = await SubjectMapping.findById(req.params.id);
    if (!mapping) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: mapping });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Update mapping
exports.updateSubjectMapping = async (req, res) => {
  try {
    const { track, category, categoryValue, subjects, isActive } = req.body;
    const updated = await SubjectMapping.findByIdAndUpdate(
      req.params.id,
      { track, category, categoryValue, subjects, isActive },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Delete mapping
exports.deleteSubjectMapping = async (req, res) => {
  try {
    const deleted = await SubjectMapping.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
