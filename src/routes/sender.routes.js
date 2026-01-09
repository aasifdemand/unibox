import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  createSender,
  listSenders,
} from "../controllers/sender.controller.js";

const router = Router();

router.post("/create", protect, createSender);
router.get("/", protect, listSenders);


export default router;
