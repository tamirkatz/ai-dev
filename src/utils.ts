import { execSync } from "child_process";
import { existsSync } from "fs";
import simpleGit, { SimpleGit } from "simple-git";
import { promises as fs } from "fs";
import path from "path";
import { embedRepoFiles, searchRelevantFiles } from "./vectorStore.ts";
import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Make sure this is set in your .env file
});

interface ChangedFile {
  fullPath: string;
  relativePath: string;
}

function cleanFileContent(rawContent: string): string {
  return rawContent
    .replace(/^```[a-z]*\n?/i, "") // remove ```js or ```ts at the start
    .replace(/\n?```$/, "") // remove trailing ```
    .trim();
}

export async function prepareRepository(repoUrl: string, localPath: string) {
  const git = simpleGit();
  console.log("🔵 [prepareRepository] Checking repository at", localPath);

  if (existsSync(localPath)) {
    console.log("🔵 [prepareRepository] Repo exists, pulling latest changes");

    const repoGit = simpleGit(localPath);
    const branchSummary = await repoGit.branch(["-r"]);
    const remoteBranches = branchSummary.all;

    const defaultBranch = remoteBranches.find((b) => b.endsWith("/main"))
      ? "main"
      : remoteBranches.find((b) => b.endsWith("/master"))
      ? "master"
      : null;

    if (!defaultBranch) {
      throw new Error(
        "❌ Could not determine default branch (main/master not found)"
      );
    }

    console.log(`🌿 [prepareRepository] Default branch is '${defaultBranch}'`);

    await repoGit.checkout(defaultBranch);
    await repoGit.pull("origin", defaultBranch);
    console.log("🟢 [prepareRepository] Pull complete");
  } else {
    console.log("🔵 [prepareRepository] Cloning repository from", repoUrl);
    await git.clone(repoUrl, localPath);
    console.log("🟢 [prepareRepository] Clone complete");
  }
}

export function installDependencies(cwd: string) {
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

/**
 * Gather a text blob of the most relevant source files for this task.
 * Passes the full task description into the retriever so it “sees” default vs named exports.
 */
async function gatherRepoContext(
  directory: string,
  taskDescription: string
): Promise<string> {
  const srcDir = path.join(directory, "src");
  console.log("🔵 [gatherRepoContext] Checking srcDir:", srcDir);

  if (existsSync(srcDir)) {
    console.log("🔵 [gatherRepoContext] Embedding files");
    // Feed the full description, not just an opaque key
    const collection = await embedRepoFiles(srcDir, taskDescription);
    // Increase topK to ensure coverage of all relevant files
    const relevant = await searchRelevantFiles(collection, taskDescription, 20);

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

async function gatherFilesContent(paths: string[]): Promise<string> {
  const contents = await Promise.all(
    paths.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf-8");
      return `--- File (${filePath}) ---\n${content}`;
    })
  );
  return contents.join("\n");
}

interface ChangedFile {
  fullPath: string;
  relativePath: string;
}

export async function applyAiChanges(
  localPath: string,
  aiResponse: string
): Promise<ChangedFile[]> {
  console.log("🔵 [applyAiChanges] Applying AI changes");
  console.log("🔵 [applyAiChanges] AI response:", aiResponse);
  const changedFiles: ChangedFile[] = [];
  const fileBlocks = aiResponse.split("- Path: ").slice(1);

  for (const block of fileBlocks) {
    const [filePathLine, ...contentLines] = block.split("\n");
    const relativeFilePath = filePathLine.trim();

    const contentStartIndex = contentLines.findIndex((line) =>
      line.trim().startsWith("- Content:")
    );
    if (contentStartIndex === -1) continue;

    const content = cleanFileContent(
      contentLines.slice(contentStartIndex + 1).join("\n")
    );

    const fullFilePath = path.join(localPath, relativeFilePath);
    console.log("fullFilePath:", fullFilePath);
    console.log("relativeFilePath:", relativeFilePath);

    await fs.mkdir(path.dirname(fullFilePath), { recursive: true });

    // 🛡️ Special handling for package.json
    if (relativeFilePath === "package.json") {
      const existing = existsSync(fullFilePath)
        ? JSON.parse(await fs.readFile(fullFilePath, "utf-8"))
        : {};
      const aiPkg = JSON.parse(content);

      // Merge scripts (additive only)
      existing.scripts = {
        ...existing.scripts,
        ...Object.fromEntries(
          Object.entries(aiPkg.scripts || {}).filter(
            ([key]) => !(key in (existing.scripts || {}))
          )
        ),
      };

      // Merge dependencies
      existing.dependencies = {
        ...existing.dependencies,
        ...Object.fromEntries(
          Object.entries(aiPkg.dependencies || {}).filter(
            ([key]) => !(key in (existing.dependencies || {}))
          )
        ),
      };

      // Merge devDependencies
      existing.devDependencies = {
        ...existing.devDependencies,
        ...Object.fromEntries(
          Object.entries(aiPkg.devDependencies || {}).filter(
            ([key]) => !(key in (existing.devDependencies || {}))
          )
        ),
      };

      await fs.writeFile(fullFilePath, JSON.stringify(existing, null, 2));
    } else {
      await fs.writeFile(fullFilePath, content, "utf-8");
    }

    changedFiles.push({
      fullPath: fullFilePath,
      relativePath: relativeFilePath,
    });
  }

  return changedFiles;
}

const MAX_RETRIES = 3;
const MAX_PROMPT_LENGTH = 8000;

interface IterationResult {
  attempt: number;
  prompt: string;
  aiResponse: string;
  buildError?: string;
  testFailures?: string;
  changedFiles: string[];
}

export function buildProject(cwd: string): {
  success: boolean;
  errorOutput?: string;
} {
  try {
    execSync("npm run build", { cwd, stdio: "pipe" });
    return { success: true };
  } catch (err: any) {
    const errorOutput =
      err.stdout?.toString() ||
      err.stderr?.toString() ||
      err.message ||
      String(err);
    return { success: false, errorOutput };
  }
}

function buildPrompt(
  repoContext: string,
  issueSummary: string,
  issueDescription: string
): string {
  return `
You are an expert software engineer collaborating on a real codebase.
Your job is to implement the change described below—exactly and completely.

--- REPOSITORY CONTEXT ---
${repoContext || "No files in repo. Might be a new project."}

--- ISSUE ---
${issueSummary}
${issueDescription}

--- GUIDELINES ---
• Only output file modifications.  
• Use this exact format (no markdown/backticks!):  
  - Path: <relative/path/to/file>  
  - Content:  
  <entire, updated file content here>  

• If new dependencies are required (for tests, lint rules, runtime, etc.), update package.json accordingly.  
• Do not include explanations, comments, or JSON. Only code.  
• If no files need changing, return nothing.
`.trim();
}

/**
 * Detects default branch and creates a new feature branch from it.
 */
export async function createFeatureBranch(
  git: SimpleGit,
  issueKey: string
): Promise<string> {
  const branchName = `feature/${issueKey}`;

  console.log("🌿 [createFeatureBranch] Detecting default branch...");
  const branchSummary = await git.branch(["-r"]);

  const remoteBranches = branchSummary.all;
  const defaultBranch = remoteBranches.find((b) => b.endsWith("/main"))
    ? "main"
    : remoteBranches.find((b) => b.endsWith("/master"))
    ? "master"
    : null;

  if (!defaultBranch) {
    throw new Error(
      "❌ Could not determine default branch (main/master not found)"
    );
  }

  console.log(
    `🔍 [createFeatureBranch] Default branch detected: ${defaultBranch}`
  );
  console.log(`🌿 [createFeatureBranch] Checking out '${defaultBranch}'...`);
  await git.checkout(defaultBranch);
  await git.pull("origin", defaultBranch);

  console.log(
    `🌱 [createFeatureBranch] Creating and switching to new branch: ${branchName}`
  );
  await git.checkoutLocalBranch(branchName);

  console.log(
    `✅ [createFeatureBranch] Branch ${branchName} created successfully.`
  );
  return branchName;
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

/**
 * Iteratively prompts the AI to implement the requested change.
 * On each retry, feeds back any build/test errors so it can correct itself.
 */
export async function iterativeCodeGeneration(
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

    // Give the retriever the full narrative so it pulls in the right files
    const repoContext = await gatherRepoContext(
      localPath,
      `${summary}\n\n${currentDescription}`
    );

    const prompt = buildPrompt(repoContext, summary, currentDescription);
    console.log(`🔵 [iterativeCodeGeneration] Prompt length ${prompt.length}`);

    const aiResponse = await generateAiChange(prompt);
    console.log(
      `🟣 [iterativeCodeGeneration] AI response length ${aiResponse.length}`
    );

    const changed = await applyAiChanges(localPath, aiResponse);
    console.log("🟢 [iterativeCodeGeneration] Changed files:", changed);
    changed.forEach((f) => allChanged.add(f.relativePath));

    let buildError: string | undefined;
    let testFailures: string | undefined;

    try {
      console.log("🔵 [iterativeCodeGeneration] Building project");
      const buildResult = buildProject(localPath);

      if (!buildResult.success) {
        buildError = buildResult.errorOutput;
        throw new Error(buildError);
      }

      console.log("🟢 [iterativeCodeGeneration] Build succeeded");
    } catch (err: any) {
      const errMsg = err.message || String(err);

      if (errMsg.includes("Test failed")) {
        testFailures = errMsg;
        console.error(
          `🔴 [iterativeCodeGeneration] Tests failed on attempt ${attemptNum}: ${testFailures}`
        );
      } else {
        buildError = errMsg;
        console.error(
          `🔴 [iterativeCodeGeneration] Build failed on attempt ${attemptNum}: ${buildError}`
        );
      }

      // Feed back errors so the next iteration can correct them
      currentDescription = `Previous code generated errors:\n${
        buildError || testFailures
      }\nPlease provide corrected code changes.`;
      console.log(
        "🔵 [iterativeCodeGeneration] Updated description for next attempt:",
        currentDescription
      );

      attempt++;
    }

    iterations.push({
      attempt: attemptNum,
      prompt,
      aiResponse,
      buildError,
      testFailures,
      changedFiles: changed.map((file) => file.relativePath),
    });

    if (!buildError && !testFailures) {
      break;
    }
  }

  return { changedFiles: Array.from(allChanged), iterations };
}
