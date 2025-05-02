import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { simpleGit } from "simple-git";
import { OpenAI } from "openai";
import { promises as fs, existsSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { embedRepoFiles, searchRelevantFiles } from "../vectorStore.ts";

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

    try {
      let repoGit;
      if (existsSync(localPath)) {
        console.log("🔄 Repo already exists — pulling latest changes...");
        repoGit = simpleGit(localPath);
        await repoGit.checkout("main");
        await repoGit.pull("origin", "main");
      } else {
        console.log("🚀 Cloning fresh repo...");
        await git.clone(repoUrl, localPath);
        repoGit = simpleGit(localPath);
      }

      const x = Math.floor(Math.random() * 1000);
      const branchName = `feature/${issueKey}${x}`;
      console.log("🌿 Creating new branch...");
      await repoGit.checkoutLocalBranch(branchName);

      let repoContext = "";
      const srcDir = path.join(localPath, "src");

      try {
        const stat = await fs.stat(srcDir);
        if (stat.isDirectory()) {
          console.log("📦 Embedding repo files...");
          const collection = await embedRepoFiles(srcDir, issueKey);

          console.log("🔎 Searching relevant files...");
          const relevantFiles = await searchRelevantFiles(
            collection,
            issueDescription
          );

          repoContext = `Top relevant files:\n${relevantFiles
            .map(
              (f, i) =>
                `--- File ${i + 1} ---\n content:${f.content} ---\n path: ${
                  f.path
                }`
            )
            .join("\n")}`;
        }
      } catch {
        console.warn(
          "⚠️ 'src/' directory does not exist or can't be read. Skipping embeddings."
        );
      }

      const prompt = `
You are an expert software engineer. Based on the following repository context and issue details, provide the **exact code changes** required to complete the task.

--- REPOSITORY CONTEXT ---
${repoContext || "No files available. This might be a new repository."}

--- ISSUE DETAILS ---
Title: ${issueSummary}
Description: ${issueDescription}

--- INSTRUCTIONS ---
Only output file modifications using this format (use relative paths, like src/index.ts):
- Path: src/index.ts
- Content:
<complete file content goes here — DO NOT include markdown formatting such as triple backticks>

IMPORTANT: Do not include any triple backticks  or markdown syntax. Only raw file paths and content.
Do not include explanations, just the code changes.
`;

      console.log("💬 Sending to OpenAI...");
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });

      const aiResponse = completion.choices[0].message.content ?? "";
      console.log("🤖 OpenAI response received.");

      const changedFiles = await applyAiChanges(localPath, aiResponse);

      console.log("🛠️ Committing and pushing...");
      await repoGit.addConfig("user.name", issue.userName); // e.g., "John Doe"
      await repoGit.addConfig("user.email", issue.userEmail); // e.g., "john@example.com"
      await repoGit.add(".");
      await repoGit.commit(`feat(${issueKey}): ${issueSummary}`);
      await repoGit.push("origin", branchName);

      console.log(`✅ Branch ${branchName} pushed successfully.`);
      res.status(200).send({
        message: "Branch pushed successfully.",
        changedFiles: changedFiles.map((f) => f.relativePath),
      });
    } catch (error: any) {
      console.error("❌ Error:", error);
      res.status(500).send({ error: error.message });
    }
  }
);

function cleanFileContent(rawContent: string): string {
  return rawContent
    .replace(/^```[a-z]*\n?/i, "") // remove ```js or ```ts at the start
    .replace(/\n?```$/, "") // remove trailing ```
    .trim();
}

interface ChangedFile {
  fullPath: string;
  relativePath: string;
}

async function applyAiChanges(
  localPath: string,
  aiResponse: string
): Promise<ChangedFile[]> {
  const changedFiles: ChangedFile[] = [];
  const fileBlocks = aiResponse.split("- Path: ").slice(1);

  for (const block of fileBlocks) {
    const [filePathLine, ...contentLines] = block.split("\n");
    const relativeFilePath = filePathLine.trim();

    const contentStartIndex = contentLines.findIndex((line) =>
      line.startsWith("- Content:")
    );
    if (contentStartIndex === -1) continue;

    const content = cleanFileContent(
      contentLines.slice(contentStartIndex + 1).join("\n")
    );

    const fullFilePath = path.join(localPath, relativeFilePath);
    console.log("fullFilePath:", fullFilePath);
    console.log("relativeFilePath:", relativeFilePath);

    await fs.mkdir(path.dirname(fullFilePath), { recursive: true });
    await fs.writeFile(fullFilePath, content, "utf-8");

    changedFiles.push({
      fullPath: fullFilePath,
      relativePath: relativeFilePath,
    });
  }

  return changedFiles;
}

export default router;
