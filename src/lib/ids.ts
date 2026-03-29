export function createJobId(prefix = "job") {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${now}_${random}`;
}
