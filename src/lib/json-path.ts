export function setByPath(target, pathExpression, value) {
  const parts = pathExpression.split(".").filter(Boolean);
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts.at(-1)] = coerceValue(value);
  return target;
}

export function getByPath(target, pathExpression) {
  const parts = pathExpression.split(".").filter(Boolean);
  let current = target;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function coerceValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
