const express = require("express");
const { getDb } = require("../DB/mongo");
const requireAuth = require("../middleware/requireAuth");
const { getOverview } = require("../services/mongoData");

const router = express.Router();

router.get("/me/overview", requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const uid = req.user.id;
    const user = await db.collection("users").findOne(
      { id: uid },
      { projection: { _id: 0, id: 1, name: 1, mobile: 1, email: 1 } }
    );

    if (!user) {
      return res.status(404).json({ status: false, message: "user not found" });
    }

    return res.json({
      status: true,
      message: "OK",
      user,
      overview: await getOverview(uid),
    });
  } catch (e) {
    console.error("overview error:", e);
    return res.status(500).json({ status: false, message: "internal error" });
  }
});

module.exports = router;
