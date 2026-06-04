import pg from "pg";
import { config } from "./config.ts";

export const kbEnabled = Boolean(config.databaseUrl);

const pool = kbEnabled ? new pg.Pool({ connectionString: config.databaseUrl, max: 4 }) : null;

export interface KnowledgeRow {
  id: number;
  content: string;
  source: string;
  created_at: string;
  similarity?: number;
}

// --- Local embeddings (transformers.js, all-MiniLM-L6-v2, 384-dim) ---

let extractorP: Promise<any> | null = null;
async function getExtractor(): Promise<any> {
  if (!extractorP) {
    const { pipeline } = await import("@huggingface/transformers");
    extractorP = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return extractorP;
}

async function embed(text: string): Promise<number[]> {
  const ex = await getExtractor();
  const out = await ex(text.slice(0, 8000), { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

const toVector = (v: number[]) => `[${v.join(",")}]`;

// --- Schema ---

export async function initKnowledge(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      embedding vector(384),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Cosine-distance HNSW index for fast similarity search.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge USING hnsw (embedding vector_cosine_ops);`);
  console.log("[knowledge] ready (pgvector)");
}

// --- Operations ---

export async function addKnowledge(content: string, source = "manual"): Promise<KnowledgeRow> {
  if (!pool) throw new Error("knowledge base disabled (no DATABASE_URL)");
  const vec = await embed(content);
  const { rows } = await pool.query(
    "INSERT INTO knowledge (content, source, embedding) VALUES ($1, $2, $3::vector) RETURNING id, content, source, created_at",
    [content, source, toVector(vec)],
  );
  return rows[0];
}

export async function searchKnowledge(query: string, k = 5): Promise<KnowledgeRow[]> {
  if (!pool) return [];
  const vec = await embed(query);
  const { rows } = await pool.query(
    `SELECT id, content, source, created_at, 1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge ORDER BY embedding <=> $1::vector LIMIT $2`,
    [toVector(vec), k],
  );
  return rows;
}

export async function listKnowledge(limit = 100): Promise<KnowledgeRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query("SELECT id, content, source, created_at FROM knowledge ORDER BY id DESC LIMIT $1", [limit]);
  return rows;
}

export async function deleteKnowledge(id: number): Promise<void> {
  if (!pool) return;
  await pool.query("DELETE FROM knowledge WHERE id = $1", [id]);
}

export async function knowledgeCount(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM knowledge");
  return rows[0].n;
}
