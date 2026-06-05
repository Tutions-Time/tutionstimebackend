const mongoose = require("mongoose");

const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    excerpt: { type: String, required: true, trim: true, maxlength: 500 },
    content: { type: String, required: true },
    coverImage: { type: String, default: "" },
    coverImageAlt: { type: String, default: "" },
    category: { type: String, default: "Education", trim: true },
    tags: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
    },
    metaTitle: { type: String, default: "", trim: true },
    metaDescription: { type: String, default: "", trim: true, maxlength: 180 },
    authorName: { type: String, default: "tuitionstime Team", trim: true },
    createdBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

blogSchema.index({ slug: 1 }, { unique: true });
blogSchema.index({ status: 1, publishedAt: -1 });
blogSchema.index({ title: "text", excerpt: "text", content: "text", tags: "text" });

module.exports = mongoose.models.Blog || mongoose.model("Blog", blogSchema);
