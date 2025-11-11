const express = require("express");
const router = express.Router();
const metaController = require("../controllers/metaController");
const { authenticate, checkRole } = require("../middleware/auth");

// ===== Option Categories CRUD =====
router.post(
  "/categories",
  authenticate,
  checkRole(["admin"]),
  metaController.createCategory
);
router.get("/categories", authenticate, metaController.getCategories);
router.get("/categories/:id", authenticate, metaController.getCategoryById);
router.put(
  "/categories/:id",
  authenticate,
  checkRole(["admin"]),
  metaController.updateCategory
);
router.delete(
  "/categories/:id",
  authenticate,
  checkRole(["admin"]),
  metaController.deleteCategory
);

// ===== Subject Mappings CRUD =====
router.post(
  "/subjects",
  authenticate,
  checkRole(["admin"]),
  metaController.createSubjectMapping
);
router.get("/subjects", authenticate, metaController.getSubjectMappings);
router.get("/subjects/:id", authenticate, metaController.getSubjectMappingById);
router.put(
  "/subjects/:id",
  authenticate,
  checkRole(["admin"]),
  metaController.updateSubjectMapping
);
router.delete(
  "/subjects/:id",
  authenticate,
  checkRole(["admin"]),
  metaController.deleteSubjectMapping
);

module.exports = router;
