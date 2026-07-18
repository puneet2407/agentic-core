import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";

/**
 * Local embeddings (Layer 5/9) — real semantic vectors with zero services.
 *
 * Uses Transformers.js (ONNX, in-process, CPU) with a small sentence-embedding
 * model. The package is an OPT-IN install to keep the core dependency-free:
 *
 *   npm install @huggingface/transformers
 *
 * First use downloads the model (~25MB) to the local HF cache; afterwards it
 * works fully offline. If the package or model is unavailable, callers fall
 * back to keyword-overlap scoring — the system never breaks.
 */
export interface Embedder {
  name: string;
  /** Returns one normalized vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

export async function createTransformersEmbedder(
  model = config.embeddingModel,
): Promise<Embedder> {
  // Non-literal specifier: keeps typecheck/build green when the optional
  // package isn't installed; failure is handled by the caller's fallback.
  const specifier = "@huggingface/transformers";
  const mod = (await import(specifier)) as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  const extractor = (await mod.pipeline("feature-extraction", model, { dtype: "q8" })) as (
    texts: string[],
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ dims: number[]; data: Float32Array }>;

  logger.info("local embedder ready", { model });
  return {
    name: `transformers:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      const [rows, dim] = [out.dims[0]!, out.dims[1]!];
      const vectors: number[][] = [];
      for (let i = 0; i < rows; i++) {
        vectors.push(Array.from(out.data.slice(i * dim, (i + 1) * dim)));
      }
      return vectors;
    },
  };
}

/** Cosine similarity — for normalized vectors this is the dot product. */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
