// Common English stop words to exclude from market question tokenization
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'that', 'this',
  'these', 'those', 'it', 'its', 'as', 'if', 'then', 'than', 'so',
  'not', 'no', 'nor', 'yet', 'both', 'either', 'neither', 'each',
  'any', 'all', 'most', 'more', 'some', 'such', 'what', 'which',
  'who', 'whom', 'how', 'when', 'where', 'why', 'whether', 'before',
  'after', 'during', 'while', 'until', 'about', 'into', 'through',
  'over', 'under', 'between', 'among', 'within', 'without', 'against',
  'up', 'down', 'out', 'off', 'above', 'below', 'there', 'here',
]);

/**
 * Tokenizes a market question string into lowercase non-stop-word tokens.
 * Splits on any non-alphabetic character, lowercases, removes stop words,
 * and filters out tokens shorter than 2 characters.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/**
 * Computes TF-IDF vectors for a collection of documents (each document is a
 * pre-tokenized array of terms).
 *
 * TF  = count(term in doc) / total terms in doc
 * IDF = ln(1 + N / (1 + df(term)))  — smooth IDF to avoid division by zero
 *
 * Returns one Map<term, tfidf_score> per document, in the same order as input.
 */
export function tfidf(docs: string[][]): Map<string, number>[] {
  const N = docs.length;
  if (N === 0) return [];

  // Document frequency: how many documents contain each term
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const term of doc) {
      if (!seen.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
        seen.add(term);
      }
    }
  }

  return docs.map((doc) => {
    const vector = new Map<string, number>();
    if (doc.length === 0) return vector;

    // Term frequency for this document
    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    for (const [term, count] of tf) {
      const termTf = count / doc.length;
      const termDf = df.get(term) ?? 0;
      const termIdf = Math.log(1 + N / (1 + termDf));
      vector.set(term, termTf * termIdf);
    }

    return vector;
  });
}

/**
 * Cosine similarity between two TF-IDF vectors.
 * Returns a value in [0, 1]. Returns 0 if either vector is empty.
 */
export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  if (a.size === 0 || b.size === 0) return 0;

  // Dot product (iterate over smaller map for efficiency)
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, scoreA] of smaller) {
    const scoreB = larger.get(term);
    if (scoreB !== undefined) {
      dot += scoreA * scoreB;
    }
  }

  // Magnitudes
  let magA = 0;
  for (const v of a.values()) magA += v * v;

  let magB = 0;
  for (const v of b.values()) magB += v * v;

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Jaccard similarity between two token arrays.
 * |intersection| / |union|. Returns 0 for two empty arrays.
 */
export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Combined market similarity score between two market question strings.
 *
 * Blends Jaccard (lexical overlap) and cosine TF-IDF similarity using a
 * weighted average. Jaccard weight 0.4, cosine weight 0.6 — cosine is
 * weighted higher because it captures term importance (rare shared terms
 * are more informative than common ones).
 *
 * Returns a value in [0, 1].
 */
export function marketSimilarity(questionA: string, questionB: string): number {
  const tokensA = tokenize(questionA);
  const tokensB = tokenize(questionB);

  const jaccard = jaccardSimilarity(tokensA, tokensB);

  const [vecA, vecB] = tfidf([tokensA, tokensB]);
  const cosine = cosineSimilarity(vecA!, vecB!);

  return 0.4 * jaccard + 0.6 * cosine;
}
