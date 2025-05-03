import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { simpleGit, SimpleGit } from "simple-git";
import { OpenAI } from "openai";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";
import { embedRepoFiles, searchRelevantFiles } from "../vectorStore.ts";

const router = express.Router();
const git = simpleGit();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_RETRIES = 3;

interface AiTaskRequest {
  issueKey?: string;
  issueSummary?: string;
  issueDescription?: string;
  repo: string;
  userName: string;
  userEmail: string;
}

interface IterationResult {
  attempt: number;
  prompt: string;
  aiResponse: string;
  buildError?: string;
  testFailures?: string;
  changedFiles: string[];
}

router.post(
  "/ai-task",
  async (
    req: Request<{}, any, AiTaskRequest>,
    res: Response,
    _next: NextFunction
  ) => {
    console.log("🔵 [Router] /ai-task called with body:", req.body);
    const issue = req.body;
    try {
      const result = await handleAiTask(issue);
      console.log("🟢 [Router] Task completed with result:", result);
      res.status(200).send(result);
    } catch (error: any) {
      console.error("🔴 [Router] AI Task failed:", error);
      res.status(500).send({ error: error.message, stack: error.stack });
    }
  }
);

async function handleAiTask(issue: AiTaskRequest) {
  console.log("🔵 [handleAiTask] Starting handler with issue:", issue);
  if (!issue.repo) throw new Error("Missing repo URL in request.");

  const issueKey = issue.issueKey || "temp-issue";
  const summary = issue.issueSummary || "AI Task";
  let description = issue.issueDescription || "No description provided.";
  console.log(`🔵 [handleAiTask] issueKey=${issueKey}, summary=${summary}`);

  const repoUrl = issue.repo;
  const hash = crypto.createHash("md5").update(repoUrl).digest("hex");
  const localPath = path.join(
    os.tmpdir(),
    "ai-assist-repos",
    `${issueKey}-${hash}`
  );
  console.log(`🔵 [handleAiTask] Using localPath=${localPath}`);

  // prepare code and dependencies
  await prepareRepository(repoUrl, localPath);
  installDependencies(localPath);

  const repoGit = simpleGit(localPath);
  const branch = await createFeatureBranch(repoGit, issueKey);

  const { changedFiles, iterations } = await iterativeCodeGeneration(
    localPath,
    issueKey,
    summary,
    description
  );

  // commit & push
  console.log(
    "🔵 [handleAiTask] Committing and pushing changes for branch:",
    branch
  );
  await repoGit.addConfig("user.name", issue.userName);
  await repoGit.addConfig("user.email", issue.userEmail);
  await repoGit.add(".");
  await repoGit.commit(`feat(${issueKey}): ${summary}`);
  await repoGit.push("origin", branch);

  console.log("🟢 [handleAiTask] Branch pushed successfully:", branch);
  return {
    message: `Branch ${branch} pushed successfully.`,
    changedFiles,
    iterations,
  };
}

async function prepareRepository(repoUrl: string, localPath: string) {
  console.log("🔵 [prepareRepository] Checking repository at", localPath);
  if (existsSync(localPath)) {
    console.log("🔵 [prepareRepository] Repo exists, pulling latest changes");
    const repoGit = simpleGit(localPath);
    await repoGit.checkout("main");
    await repoGit.pull("origin", "main");
    console.log("🟢 [prepareRepository] Pull complete");
  } else {
    console.log("🔵 [prepareRepository] Cloning repository from", repoUrl);
    await git.clone(repoUrl, localPath);
    console.log("🟢 [prepareRepository] Clone complete");
  }
}

function installDependencies(cwd: string) {
  console.log("🔵 [installDependencies] Installing NPM dependencies");
  try {
    execSync("npm ci --ignore-scripts", { cwd, stdio: "pipe" });
    console.log("🟢 [installDependencies] Dependencies installed");
  } catch (err: any) {
    console.warn(
      "⚠️ [installDependencies] npm ci failed, attempting npm install"
    );
    execSync("npm install", { cwd, stdio: "pipe" });
    console.log("🟢 [installDependencies] npm install complete");
  }
}

async function createFeatureBranch(repoGit: SimpleGit, issueKey: string) {
  const count = Math.floor(Math.random() * 1000);
  const branch = `feature/${issueKey}-${count}`;
  console.log("🔵 [createFeatureBranch] Creating branch", branch);
  await repoGit.checkoutLocalBranch(branch);
  console.log("🟢 [createFeatureBranch] Branch created:", branch);
  return branch;
}

async function iterativeCodeGeneration(
  localPath: string,
  issueKey: string,
  summary: string,
  description: string
): Promise<{ changedFiles: string[]; iterations: IterationResult[] }> {
  console.log(
    "🔵 [iterativeCodeGeneration] Starting iterative code generation"
  );
  let attempt = 0;
  const allChanged = new Set<string>();
  let currentDescription = description;
  const iterations: IterationResult[] = [];

  while (attempt < MAX_RETRIES) {
    const attemptNum = attempt + 1;
    console.log(
      `🔵 [iterativeCodeGeneration] Attempt ${attemptNum}/${MAX_RETRIES}`
    );
    const repoContext = await gatherRepoContext(localPath, issueKey);
    const prompt = buildPrompt(repoContext, summary, currentDescription);
    console.log(`🔵 [iterativeCodeGeneration] Prompt length ${prompt.length}`);

    const aiResponse = await generateAiChange(prompt);
    console.log(
      `🟣 [iterativeCodeGeneration] AI response length ${aiResponse.length}`
    );

    const changed = await applyAiChanges(localPath, aiResponse);
    console.log("🟢 [iterativeCodeGeneration] Changed files:", changed);
    changed.forEach((f) => allChanged.add(f));

    let buildError: string | undefined;
    let testFailures: string | undefined;
    try {
      console.log("🔵 [iterativeCodeGeneration] Building project");
      buildProject(localPath);
      console.log("🟢 [iterativeCodeGeneration] Build succeeded");

      console.log("🔵 [iterativeCodeGeneration] Generating tests");
      generateTests(localPath, changed);

      console.log("🔵 [iterativeCodeGeneration] Running tests");
      runTests(localPath);

      console.log("🟢 [iterativeCodeGeneration] Tests passed");
    } catch (err: any) {
      if (err.message.includes("Test failed")) {
        testFailures = err.message;
        console.error(
          `🔴 [iterativeCodeGeneration] Tests failed on attempt ${attemptNum}:`,
          testFailures
        );
      } else {
        buildError = err.message;
        console.error(
          `🔴 [iterativeCodeGeneration] Build failed on attempt ${attemptNum}:`,
          buildError
        );
      }
      attempt++;
      currentDescription = `Previous code generated errors:\n${
        buildError || testFailures
      }\nPlease provide corrected code changes.`;
      console.log(
        "🔵 [iterativeCodeGeneration] Updated description for next attempt"
      );
    }

    iterations.push({
      attempt: attemptNum,
      prompt,
      aiResponse,
      buildError,
      testFailures,
      changedFiles: changed,
    });
    if (!buildError && !testFailures) break;
  }

  return { changedFiles: Array.from(allChanged), iterations };
}

async function gatherRepoContext(directory: string, issueKey: string) {
  const srcDir = path.join(directory, "src");
  console.log("🔵 [gatherRepoContext] Checking srcDir:", srcDir);
  if (existsSync(srcDir)) {
    console.log("🔵 [gatherRepoContext] Embedding files");
    const collection = await embedRepoFiles(srcDir, issueKey);
    const relevant = await searchRelevantFiles(collection, issueKey);
    console.log(
      "🔵 [gatherRepoContext] Relevant files count:",
      relevant.length
    );
    return relevant
      .map((f, i) => `--- File ${i + 1} (${f.path}) ---\n${f.content}`)
      .join("\n");
  }
  console.warn("⚠️ [gatherRepoContext] No srcDir");
  return "No files available.";
}

function buildPrompt(
  repoContext: string,
  summary: string,
  description: string
) {
  return `You are an expert software engineer. Based on the following repository context and issue details, provide the exact code changes required.

--- REPO CONTEXT ---
${repoContext}

--- ISSUE ---
Title: ${summary}
Description: ${description}

Format:
- Path: <relative/path>
- Content:
<full file content, no markdown>

Do not include explanations.`;
}

async function generateAiChange(prompt: string): Promise<string> {
  console.log("🔵 [generateAiChange] Sending prompt to OpenAI");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
  });
  return resp.choices[0].message.content || "";
}

function buildProject(cwd: string) {
  execSync("npm run build", { cwd, stdio: "pipe" });
}

async function applyAiChanges(
  localPath: string,
  aiResponse: string
): Promise<string[]> {
  console.log("🔵 [applyAiChanges] Parsing AI response");
  const fileRegex =
    /- Path: ([^\n]+)\n- Content:\n([\s\S]*?)(?=(?:\n- Path:|$))/g;
  const changed: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(aiResponse))) {
    const relPath = match[1].trim();

    // ——— Skip any placeholder or obviously invalid entries —————————
    if (relPath.startsWith("<") || relPath.includes(">")) {
      console.warn(`[applyAiChanges] Skipping invalid AI path: ${relPath}`);
      continue;
    }

    const content = cleanContent(match[2]);
    console.log(
      `🔵 [applyAiChanges] Writing file ${relPath} (${content.length} chars)`
    );

    const fullPath = path.join(localPath, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    changed.push(relPath);
  }

  console.log("🟢 [applyAiChanges] Total files written:", changed.length);
  return changed;
}

function cleanContent(raw: string): string {
  return raw
    .replace(/^```[a-z]*\n/, "")
    .replace(/\n```$/m, "")
    .trim();
}

/**
 * For each changed file, create a minimal smoke-test in __tests__/
 */
async function generateTests(
  cwd: string,
  changedFiles: string[]
): Promise<void> {
  console.log("🔵 [generateTests] Creating test files for changed files");
  for (const relFile of changedFiles) {
    const ext = path.extname(relFile);
    const base = path.basename(relFile, ext);
    const testFileRel = path.join(
      "__tests__",
      relFile.replace(ext, `.test${ext}`)
    );
    const testFilePath = path.join(cwd, testFileRel);
    const importPath = path
      .relative(path.dirname(testFilePath), path.join(cwd, relFile))
      .replace(/\\/g, "/");

    const content = `import ${base} from '${importPath}';

describe('${relFile}', () => {
  it('should be defined', () => {
    expect(${base}).toBeDefined();
  });
});
`;

    await fs.mkdir(path.dirname(testFilePath), { recursive: true });
    await fs.writeFile(testFilePath, content, "utf8");
    console.log(`🟢 [generateTests] Test file created: ${testFileRel}`);
  }
}

/**
 * Run Jest in CI mode; on any failures, throw an error prefixed with "Test failed"
 */
function runTests(cwd: string): void {
  console.log("🔵 [runTests] Running Jest tests");
  try {
    // Adjust the command as needed if your npm script differs
    execSync("npm test -- --ci --runInBand", { cwd, stdio: "inherit" });
  } catch (err: any) {
    // Wrap so that iterativeCodeGeneration sees "Test failed"
    throw new Error(`Test failed: ${err.message}`);
  }
}

export default router;
