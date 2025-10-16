const Subject = require('../models/Subject');

// Get all subjects
exports.getAllSubjects = async (req, res) => {
  try {
    const subjects = await Subject.find({ active: true });
    res.status(200).json({ success: true, data: subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch subjects' });
  }
};

// Create a new subject (admin only)
exports.createSubject = async (req, res) => {
  try {
    const { name, active } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: 'Subject name is required' });
    }
    
    const existingSubject = await Subject.findOne({ name });
    if (existingSubject) {
      return res.status(400).json({ success: false, message: 'Subject already exists' });
    }
    
    const subject = new Subject({
      name,
      active: active !== undefined ? active : true
    });
    
    await subject.save();
    res.status(201).json({ success: true, data: subject });
  } catch (error) {
    console.error('Error creating subject:', error);
    res.status(500).json({ success: false, message: 'Failed to create subject' });
  }
};

// Update a subject (admin only)
exports.updateSubject = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, active } = req.body;
    
    const subject = await Subject.findById(id);
    if (!subject) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    if (name) subject.name = name;
    if (active !== undefined) subject.active = active;
    
    await subject.save();
    res.status(200).json({ success: true, data: subject });
  } catch (error) {
    console.error('Error updating subject:', error);
    res.status(500).json({ success: false, message: 'Failed to update subject' });
  }
};

// Delete a subject (admin only)
exports.deleteSubject = async (req, res) => {
  try {
    const { id } = req.params;
    
    const subject = await Subject.findById(id);
    if (!subject) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    // Soft delete by setting active to false
    subject.active = false;
    await subject.save();
    
    res.status(200).json({ success: true, message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Error deleting subject:', error);
    res.status(500).json({ success: false, message: 'Failed to delete subject' });
  }
};