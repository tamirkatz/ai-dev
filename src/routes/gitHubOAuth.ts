// src/routes/githubOAuth.ts
import express from "express";
import cors from "cors";
import axios from "axios";
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();
router.use(cors());

// where we'll keep tokens per Jira accountId
const TOKENS_FILE = path.join(__dirname, "..", "github_tokens.json");
const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SERVER_BASE_URL } =
  process.env!;

// helper to read/write JSON
async function readTokens(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(TOKENS_FILE, "utf-8"));
  } catch {
    return {};
  }
}
async function writeTokens(data: Record<string, string>) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2));
}

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
