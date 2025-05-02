import express from "express";
const router = express.Router();
import aiRoutes from "./ai-developer.ts"; // Import the aiRoutes

router.use("/api", aiRoutes);

export default router;
