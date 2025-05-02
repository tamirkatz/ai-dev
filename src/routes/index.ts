import express from "express";
const router = express.Router();
import aiRoutes from "./ai-developer.ts"; // Import the aiRoutes
import gitHubOAuthRoutes from "./gitHubOAuth.ts"; // Import the GitHub OAuth routes

router.use("/api", aiRoutes);
router.use("/oauth", gitHubOAuthRoutes); // Add the GitHub OAuth routes

export default router;
