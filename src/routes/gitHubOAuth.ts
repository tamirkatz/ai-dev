import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const router = express.Router();
router.use(cors());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, "..", "github_tokens.json");

async function readTokens(): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(TOKENS_FILE, "utf-8");
    return JSON.parse(content);
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeTokens(data: Record<string, string>) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2));
}

// where we'll keep tokens per Jira accountId
const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SERVER_BASE_URL } = process.env;

// 1️⃣ Kick off the GitHub OAuth flow
router.get("/init", (req, res) => {
  const jiraUserId = req.query.userId as string;
  const redirectUri = `${SERVER_BASE_URL}/oauth/callback`;
  const githubAuthorizeUrl = new URL(
    "https://github.com/login/oauth/authorize"
  );
  githubAuthorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID!);
  githubAuthorizeUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthorizeUrl.searchParams.set("scope", "repo");
  githubAuthorizeUrl.searchParams.set("state", jiraUserId);
  res.redirect(githubAuthorizeUrl.toString());
});

// 2️⃣ GitHub redirects back here with ?code=…&state=JIRA_ID
router.get("/callback", async (req, res) => {
  const code = req.query.code as string;
  const jiraUserId = req.query.state as string;

  // exchange code for access_token
  const tokenResp = await axios.post(
    "https://github.com/login/oauth/access_token",
    { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
    { headers: { Accept: "application/json" } }
  );
  const accessToken = tokenResp.data.access_token as string;

  // persist
  const tokens = await readTokens();
  tokens[jiraUserId] = accessToken;
  await writeTokens(tokens);

  res.send(
    "✅ GitHub authorization successful! You can now go back to your Jira issue."
  );
});

// 3️⃣ Forge app will call this to look up the token
router.get("/token", async (req, res): Promise<void> => {
  const jiraUserId = req.query.userId as string;
  const tokens = await readTokens();
  const accessToken = tokens[jiraUserId];
  if (!accessToken) {
    res.status(404).json({ error: "token_not_found" });
  }
  res.json({ access_token: accessToken });
});

export default router;
