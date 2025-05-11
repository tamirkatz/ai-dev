import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { simpleGit } from "simple-git";
import { OpenAI } from "openai";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  createFeatureBranch,
  installDependencies,
  iterativeCodeGeneration,
  prepareRepository,
} from "../utils.ts";

const router = express.Router();
const git = simpleGit();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface AiTaskRequest {
  issueKey?: string;
  issueSummary?: string;
  issueDescription?: string;
  repo: string;
  userName: string;
  userEmail: string;
}

router.post(
  "/ai-task",
  async (
    req: Request<{}, any, AiTaskRequest>,
    res: Response,
    _next: NextFunction
  ): Promise<void> => {
    console.log("🛠️ AI Task request received.");
    const issue = req.body;

    const issueKey = issue.issueKey || "test-issue-key";
    const issueSummary = issue.issueSummary || "Default summary";
    const issueDescription =
      issue.issueDescription ||
      `
    Please create a basic Express.js server project.

    Requirements:
    - A "src/index.js" that starts a server on port 3000
    - Use express and body-parser (if needed)
    - Add a "/" route that returns a test message
    - Include a "package.json" with name, version, and dependencies
    - Add a ".gitignore" that ignores node_modules
    - Add a README.md with setup instructions
  `;

    const repoUrl = issue.repo;
    if (!repoUrl) {
      res.status(400).send({ error: "Missing repo URL in issue description." });
      return;
    }

    const repoHash = crypto.createHash("md5").update(repoUrl).digest("hex");
    const localPath = path.join(
      os.tmpdir(),
      "ai-assist-repos",
      `${issueKey}-${repoHash}`
    );

    await prepareRepository(repoUrl, localPath);
    installDependencies(localPath);
    const repoGit = simpleGit(localPath);
    const branch = await createFeatureBranch(repoGit, issueKey);

    const { changedFiles, iterations } = await iterativeCodeGeneration(
      localPath,
      issueKey,
      issueSummary,
      issueDescription
    );
    repoGit.add(changedFiles);
    await repoGit.commit(
      `feat(${issueKey}): ${issueSummary} - ${issueDescription}`
    );
    await repoGit.push("origin", branch, { "--set-upstream": null });
    res.status(200).send({
      message: "AI task completed successfully",
      changedFiles,
      iterations,
      branch,
    });
  }
);

export default router;
