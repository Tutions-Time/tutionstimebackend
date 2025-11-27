const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const uploadS3 = require("../middleware/uploadS3");
const noteController = require("../controllers/noteController");

router.use(authenticate);

router.post(
  "/",
  checkRole(["tutor"]),
  uploadS3.fields([
    { name: "pdf", maxCount: 1 },
    { name: "previews", maxCount: 5 },
  ]),
  noteController.createNote
);

router.get("/my", checkRole(["tutor"]), noteController.getMyNotes);

router.put(
  "/:id",
  checkRole(["tutor"]),
  uploadS3.fields([
    { name: "pdf", maxCount: 1 },
    { name: "previews", maxCount: 5 },
  ]),
  noteController.updateNote
);

router.delete("/:id", checkRole(["tutor"]), noteController.deleteNote);

router.get("/search", checkRole(["student", "tutor", "admin"]), noteController.searchNotes);

router.get("/purchased", checkRole(["student"]), noteController.getPurchasedNotes);
router.get("/:id/download-url", checkRole(["student"]), noteController.getDownloadUrl);

module.exports = router;

