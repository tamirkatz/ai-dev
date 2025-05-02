// vectorStore.ts
import { ChromaClient, Collection } from "chromadb";
import { OpenAI } from "openai";
import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";

dotenv.config();

const chroma = new ChromaClient({ path: "http://127.0.0.1:8000" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function embedRepoFiles(
  folderPath: string,
  collectionName: string
): Promise<Collection> {
  const files = await collectFiles(folderPath);
  const collection = await chroma.getOrCreateCollection({
    name: collectionName,
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

  return docs.map((content, i) => ({
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
