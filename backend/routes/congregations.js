import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAdmin, requireAuth } from "../middleware/requirePermission.js";
import {
  congregationsFor,
  createCongregation,
  deleteCongregation,
  joinCongregation,
  leaveCongregation,
  peopleSharingWith,
  setMembers,
  updateCongregation,
  visibleCongregations,
} from "../services/congregationService.js";

// Congregations: who reaches whom. Anyone may see the open ones and put
// themselves in; the ones an admin assigns are invisible to everyone else,
// which is the whole point of them.

const router = express.Router();
router.use(requireAuth);

const me = (req) => req.user.username;
const isAdmin = (req) => req.user?.role === "admin";

const fail = (res, error, fallback) =>
  res.status(error?.status || 500).json({ error: error?.message || fallback });

router.get("/", noCache, (req, res) => {
  try {
    res.json({
      me: me(req),
      mine: congregationsFor(me(req)),
      visible: visibleCongregations(me(req), { isAdmin: isAdmin(req) }),
      people: peopleSharingWith(me(req)),
    });
  } catch (error) {
    fail(res, error, "Could not read your congregations");
  }
});

router.post("/:id/join", (req, res) => {
  try {
    res.json(joinCongregation({ id: req.params.id, username: me(req) }));
  } catch (error) {
    fail(res, error, "Could not put you in that one");
  }
});

router.post("/:id/leave", (req, res) => {
  try {
    res.json(leaveCongregation({ id: req.params.id, username: me(req) }));
  } catch (error) {
    fail(res, error, "Could not take you out of that one");
  }
});

router.post("/", requireAdmin, (req, res) => {
  try {
    res.status(201).json(createCongregation({
      name: req.body?.name,
      description: req.body?.description,
      enrollment: req.body?.enrollment,
      members: req.body?.members,
    }));
  } catch (error) {
    fail(res, error, "Could not make that congregation");
  }
});

router.patch("/:id", requireAdmin, (req, res) => {
  try {
    res.json(updateCongregation(req.params.id, req.body || {}));
  } catch (error) {
    fail(res, error, "Could not change that congregation");
  }
});

router.put("/:id/members", requireAdmin, (req, res) => {
  try {
    res.json(setMembers(req.params.id, req.body?.members));
  } catch (error) {
    fail(res, error, "Could not set who is in it");
  }
});

router.delete("/:id", requireAdmin, (req, res) => {
  try {
    res.json(deleteCongregation(req.params.id));
  } catch (error) {
    fail(res, error, "Could not remove that congregation");
  }
});

export default router;
