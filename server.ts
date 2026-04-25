import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { GoogleGenAI } from "@google/genai";

/**
 * Server Setup:
 * This Express server handles document uploads, RAG (Retrieval-Augmented Generation) logic,
 * and semantic search using Gemini embeddings.
 */

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("rag.db");

/**
 * Database Initialization:
 * - 'documents' table stores the original files and their AI-generated summaries.
 * - 'chunks' table stores the semantically split text segments and their vector embeddings.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    summary TEXT,
    content TEXT
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER,
    content TEXT,
    embedding TEXT, -- Stored as JSON string for vector similarity search
    FOREIGN KEY(doc_id) REFERENCES documents(id)
  );
`);

/**
 * Recursive Character Text Splitter:
 * A fallback chunking strategy that splits text at natural boundaries (paragraphs, sentences)
 * while maintaining a specific chunk size and overlap to preserve context.
 */
function splitText(text: string, chunkSize: number = 1000, chunkOverlap: number = 200): string[] {
  const chunks: string[] = [];
  const separators = ["\n\n", "\n", ". ", " ", ""];
  
  function recursiveSplit(currentText: string, separatorIndex: number): void {
    if (currentText.length <= chunkSize) {
      if (currentText.trim()) chunks.push(currentText.trim());
      return;
    }

    const separator = separators[separatorIndex];
    const parts = currentText.split(separator);
    let currentChunk = "";

    for (const part of parts) {
      if ((currentChunk + (currentChunk ? separator : "") + part).length <= chunkSize) {
        currentChunk += (currentChunk ? separator : "") + part;
      } else {
        if (currentChunk.trim()) chunks.push(currentChunk.trim());
        const overlap = currentChunk.slice(-chunkOverlap);
        currentChunk = overlap + (overlap ? separator : "") + part;
      }
    }
    
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
  }

  recursiveSplit(text, 0);
  return chunks;
}

/**
 * Vector Similarity Helper:
 * Calculates the cosine similarity between two embedding vectors.
 * Used to rank document chunks based on their relevance to a user's query.
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * AI-Based Semantic Chunking:
 * Uses Gemini to intelligently split text into logical, self-contained segments.
 * This is superior to character-based splitting as it understands the meaning of the content.
 */
async function aiChunkText(text: string, ai: GoogleGenAI): Promise<string[]> {
  if (text.length < 1000) return [text];

  const model = ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Task: Split the following text into logical, self-contained semantic chunks for a math tutoring RAG system. 
Each chunk should focus on a specific concept, formula, or explanation. 
Do not lose any information. 
Return ONLY a JSON array of strings.

Text to chunk:
${text.slice(0, 15000)}`,
    config: {
      responseMimeType: "application/json",
    }
  });

  try {
    const response = await model;
    const chunks = JSON.parse(response.text || "[]");
    return Array.isArray(chunks) ? chunks : [text];
  } catch (err) {
    console.error("AI Chunking failed, falling back to recursive split:", err);
    return splitText(text, 800, 150);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  app.use(express.json());

  const upload = multer({ storage: multer.memoryStorage() });

  /**
   * API: Document Upload
   * 1. Extracts text from PDF or TXT files.
   * 2. Performs AI-based semantic chunking.
   * 3. Generates vector embeddings for each chunk using 'text-embedding-004'.
   * 4. Stores everything in the SQLite database.
   */
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let text = "";
      if (req.file.mimetype === "application/pdf") {
        const data = await pdf(req.file.buffer);
        text = data.text;
      } else {
        text = req.file.buffer.toString("utf-8");
      }

      const stmt = db.prepare("INSERT INTO documents (filename, content) VALUES (?, ?)");
      const info = stmt.run(req.file.originalname, text);
      const docId = info.lastInsertRowid;

      console.log(`Starting AI-based semantic chunking for document ${docId}...`);
      const chunks = await aiChunkText(text, ai);
      
      const chunkStmt = db.prepare("INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, ?)");
      
      console.log(`Processing ${chunks.length} AI-generated chunks for document ${docId}...`);
      
      for (const chunk of chunks) {
        try {
          const result = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text: chunk }] }]
          });
          const embedding = result.embeddings[0].values;
          chunkStmt.run(docId, chunk, JSON.stringify(embedding));
        } catch (err) {
          console.error("Embedding error:", err);
          chunkStmt.run(docId, chunk, null);
        }
      }

      res.json({ 
        id: docId, 
        filename: req.file.originalname, 
        textLength: text.length,
        text: text.slice(0, 10000) 
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to process document" });
    }
  });

  /**
   * API: List Documents
   * Returns a list of all uploaded documents and their summaries.
   */
  app.get("/api/documents", (req, res) => {
    const docs = db.prepare("SELECT id, filename, summary FROM documents").all();
    res.json(docs);
  });

  /**
   * API: Update Summary
   * Updates the AI-generated summary for a specific document.
   */
  app.post("/api/documents/:id/summary", async (req, res) => {
    const { summary } = req.body;
    const stmt = db.prepare("UPDATE documents SET summary = ? WHERE id = ?");
    stmt.run(summary, req.params.id);
    res.json({ success: true });
  });

  /**
   * API: Semantic Search (RAG)
   * 1. Generates an embedding for the user's query.
   * 2. Compares it against all stored chunk embeddings using cosine similarity.
   * 3. Returns the top 5 most relevant chunks to be used as context for the AI tutor.
   */
  app.get("/api/search", async (req, res) => {
    const { q } = req.query;
    if (!q || typeof q !== 'string') return res.json([]);
    
    try {
      const result = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: [{ parts: [{ text: q }] }]
      });
      const queryEmbedding = result.embeddings[0].values;

      const allChunks = db.prepare("SELECT content, embedding FROM chunks WHERE embedding IS NOT NULL").all();
      
      const ranked = allChunks.map((chunk: any) => ({
        content: chunk.content,
        score: cosineSimilarity(queryEmbedding, JSON.parse(chunk.embedding))
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

      res.json(ranked);
    } catch (error) {
      console.error("Search error:", error);
      const stmt = db.prepare("SELECT content FROM chunks WHERE content LIKE ? LIMIT 5");
      const results = stmt.all(`%${q}%`);
      res.json(results);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
