export function normalizeValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactValue(value) {
  return normalizeValue(value).replace(/\s+/g, "");
}

export function tokenize(value) {
  const baseTokens = normalizeValue(value).split(" ").filter(Boolean);
  const expandedTokens = new Set(baseTokens);

  for (let index = 0; index < baseTokens.length - 1; index += 1) {
    expandedTokens.add(`${baseTokens[index]}${baseTokens[index + 1]}`);
  }

  return [...expandedTokens];
}

export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
