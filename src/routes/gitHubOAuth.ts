import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOKEN_FILE = "./github_app_token.json";

export async function saveGlobalGitHubToken(token: string) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify({ token }), "utf8");
}

export async function getGlobalGitHubToken() {
  if (!(await fs.stat(TOKEN_FILE).catch(() => false))) return null;
  const data = await fs.readFile(TOKEN_FILE, "utf8");
  return JSON.parse(data).token;
}

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
  console.log("in init", jiraUserId);
  const redirectUri = `${SERVER_BASE_URL}/oauth/callback`;
  const githubAuthorizeUrl = new URL(
    "https://github.com/login/oauth/authorize"
  );
  githubAuthorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID!);
  githubAuthorizeUrl.searchParams.set("scope", "repo");
  githubAuthorizeUrl.searchParams.set("state", jiraUserId);
  return res.redirect(githubAuthorizeUrl.toString());
});

// 2️⃣ GitHub redirects back here with ?code=…&state=JIRA_ID
// GET /oauth/callback
router.get("/oauth/callback", async (req, res): Promise<any> => {
  const code = req.query.code;
  const state = req.query.state;

  const tokenResponse = await axios.post(
    "https://github.com/login/oauth/access_token",
    {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    },
    {
      headers: { Accept: "application/json" },
    }
  );

  const token = tokenResponse.data.access_token;

  // 💾 Save token securely on server
  await saveGlobalGitHubToken(token);

  return res.send(
    "✅ GitHub authorized successfully! You can close this window."
  );
});

router.get("/token", async (req, res): Promise<any> => {
  const jiraUserId = req.query.userId as string;
  const tokens = await readTokens();
  const accessToken = tokens[jiraUserId];

  if (!accessToken) {
    return res.status(404).json({ error: "token_not_found" });
  }

  return res.json({ access_token: accessToken });
});

export default router;
