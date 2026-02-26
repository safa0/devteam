/**
 * Word Error Rate (WER) calculator.
 *
 * WER = (Substitutions + Insertions + Deletions) / len(reference_words)
 *
 * Returns a ratio: 0.0 = perfect match, 1.0 = 100% error rate.
 * Values above 1.0 are possible when hypothesis is longer than reference.
 */

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Levenshtein edit distance on two word arrays (not character arrays).
 */
function editDistance(ref: string[], hyp: string[]): number {
  const m = ref.length;
  const n = hyp.length;

  // dp[i][j] = min edits to turn ref[0..i) into hyp[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] =
          1 +
          Math.min(
            dp[i - 1][j], // deletion
            dp[i][j - 1], // insertion
            dp[i - 1][j - 1] // substitution
          );
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate Word Error Rate between a reference and hypothesis transcript.
 *
 * @param reference  Ground-truth text
 * @param hypothesis Transcribed text to evaluate
 * @returns WER ratio (0.0 = perfect, higher = worse)
 */
export function calculateWER(reference: string, hypothesis: string): number {
  const refWords = normalize(reference);
  const hypWords = normalize(hypothesis);

  if (refWords.length === 0) {
    // Undefined if reference is empty; return 0 when hypothesis is also empty,
    // otherwise return 1 to signal complete error.
    return hypWords.length === 0 ? 0.0 : 1.0;
  }

  const distance = editDistance(refWords, hypWords);
  return distance / refWords.length;
}
