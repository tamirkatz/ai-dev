// vectorStore.ts
import { ChromaClient, Collection } from "chromadb";
import { OpenAI } from "openai";
import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";
import { existsSync } from "fs";
import crypto from "crypto";

dotenv.config();

const chroma = new ChromaClient({ path: "http://127.0.0.1:8000" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function embedRepoFiles(
  folderPath: string,
  collectionName: string
): Promise<Collection> {
  // Step 1: Replace invalid characters
  let safeName = collectionName.replace(/[^a-zA-Z0-9._-]/g, "_");

  // Step 2: Enforce start/end characters are alphanumeric
  if (!/^[a-zA-Z0-9]/.test(safeName)) safeName = "a" + safeName;
  if (!/[a-zA-Z0-9]$/.test(safeName)) safeName = safeName + "z";

  // Step 3: Enforce length constraints
  if (safeName.length < 3) {
    safeName = safeName.padEnd(3, "x");
  } else if (safeName.length > 64) {
    // fallback to a hash of the original name
    safeName = crypto.createHash("md5").update(collectionName).digest("hex");
  }

  const files = await collectFiles(folderPath);
  const collection = await chroma.getOrCreateCollection({
    name: safeName,
  });

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    if (!content.trim()) continue;

    const embedding = await getEmbedding(content);

    await collection.add({
      ids: [file],
      embeddings: [embedding],
      documents: [content],
      metadatas: [{ path: file }],
    });
  }

  return collection;
}

export async function searchRelevantFiles(
  collection: Collection,
  taskDescription: string,
  topK = 10
): Promise<{ content: string | null; path: string | number | true }[]> {
  const embedding = await getEmbedding(taskDescription);
  const results = await collection.query({
    queryEmbeddings: [embedding],
    nResults: topK,
  });

  const docs = results.documents?.[0] || [];
  const metadatas = results.metadatas?.[0] || [];

  return docs.map((content: any, i: number) => ({
    content,
    path: metadatas[i]?.path || `unknown_${i}.js`,
  }));
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const res = path.resolve(dir, entry.name);
      return entry.isDirectory() ? collectFiles(res) : res;
    })
  );

  return files
    .flat()
    .filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".ts") ||
        f.endsWith(".tsx") ||
        f.endsWith(".jsx")
    );
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}
