const express = require("express");
const router = express.Router();
const blogController = require("../controllers/blogController");

router.get("/", blogController.listPublishedBlogs);
router.get("/:slug", blogController.getPublishedBlogBySlug);

module.exports = router;
