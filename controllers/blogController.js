const Blog = require("../models/Blog");

const normalizeSlug = (value = "") =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const parseTags = (value) => {
  if (Array.isArray(value)) return value.map(String).map((t) => t.trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
};

const buildBlogPayload = (body, file, existing = null) => {
  const title = String(body.title || existing?.title || "").trim();
  const slug = normalizeSlug(body.slug || title);
  const status = body.status || existing?.status || "draft";
  const nextPublishedAt =
    status === "published"
      ? existing?.publishedAt || new Date()
      : status === "draft"
        ? null
        : existing?.publishedAt || null;

  return {
    title,
    slug,
    excerpt: String(body.excerpt || "").trim(),
    content: String(body.content || ""),
    coverImage: file?.location || body.coverImage || existing?.coverImage || "",
    coverImageAlt: String(body.coverImageAlt || body.title || existing?.coverImageAlt || "").trim(),
    category: String(body.category || "Education").trim(),
    tags: parseTags(body.tags),
    status,
    metaTitle: String(body.metaTitle || body.title || "").trim(),
    metaDescription: String(body.metaDescription || body.excerpt || "").trim(),
    authorName: String(body.authorName || existing?.authorName || "TuitionsTime Team").trim(),
    publishedAt: nextPublishedAt,
  };
};

const publicFields =
  "title slug excerpt content coverImage coverImageAlt category tags metaTitle metaDescription authorName publishedAt createdAt updatedAt";

exports.listPublishedBlogs = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const q = String(req.query.q || "").trim();
    const filter = { status: "published" };

    if (q) filter.$text = { $search: q };

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select(publicFields)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        blogs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPublishedBlogBySlug = async (req, res) => {
  try {
    const blog = await Blog.findOne({
      slug: req.params.slug,
      status: "published",
    })
      .select(publicFields)
      .lean();

    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });

    res.json({ success: true, data: blog });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.listAdminBlogs = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const status = String(req.query.status || "all");
    const q = String(req.query.q || "").trim();
    const filter = {};

    if (["draft", "published", "archived"].includes(status)) filter.status = status;
    if (q) filter.$text = { $search: q };

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        blogs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createBlog = async (req, res) => {
  try {
    const payload = buildBlogPayload(req.body, req.file);

    if (!payload.title || !payload.excerpt || !payload.content) {
      return res.status(400).json({
        success: false,
        message: "Title, excerpt, and content are required",
      });
    }

    const existing = await Blog.findOne({ slug: payload.slug }).select("_id").lean();
    if (existing) return res.status(409).json({ success: false, message: "Blog slug already exists" });

    const blog = await Blog.create({ ...payload, createdBy: req.user?.id || null });

    res.status(201).json({ success: true, data: blog });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateBlog = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });

    const payload = buildBlogPayload(req.body, req.file, blog);

    if (!payload.title || !payload.excerpt || !payload.content) {
      return res.status(400).json({
        success: false,
        message: "Title, excerpt, and content are required",
      });
    }

    const duplicate = await Blog.findOne({ slug: payload.slug, _id: { $ne: blog._id } })
      .select("_id")
      .lean();
    if (duplicate) return res.status(409).json({ success: false, message: "Blog slug already exists" });

    Object.assign(blog, payload);
    await blog.save();

    res.json({ success: true, data: blog });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteBlog = async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });
    res.json({ success: true, message: "Blog deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
