const mongoose = require("mongoose");
if (mongoose.models.Note) delete mongoose.models.Note;

const noteSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    subject: { type: String, required: true, trim: true },
    classLevel: { type: String, required: true, trim: true },
    board: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    pdfUrl: { type: String, required: true },
    pdfKey: { type: String, required: true },

    previewImageUrls: { type: [String], default: [] },
    previewImageKeys: { type: [String], default: [] },

    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: "TutorProfile", required: true },
  },
  { timestamps: true }
);

noteSchema.index({ title: "text", description: "text" });
noteSchema.index({ subject: 1, classLevel: 1, board: 1 });

module.exports = mongoose.model("Note", noteSchema);

