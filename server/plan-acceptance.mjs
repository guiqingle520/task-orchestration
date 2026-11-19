// The plan body uses Markdown tables headed “任务 | 验收标准”.
// Only the ID cell identifies a task. Prose, change logs and examples are not criteria.
export function extractAcceptanceByTask(markdown) {
  const front = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  const result = {};
  if (!front) return result;
  const lines = markdown.slice(front[0].length).split(/\r?\n/);
  let inTable = false;
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (fence) {
      if (line.startsWith(fence) && [...line].every(char => char === fence[0])) fence = '';
      continue;
    }
    const marker = /^(`{3,}|~{3,})/.exec(line);
    if (marker) {
      fence = marker[1];
      inTable = false;
    } else if (/^\|?\s*任务\s*\|\s*验收(?:标准|要求)\s*\|?$/.test(line)) {
      inTable = /^\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|?$/.test(lines[i + 1]?.trim() ?? '');
      if (inTable) i++;
    } else if (inTable) {
      if (!line.includes('|')) { inTable = false; continue; }
      const row = /^\|?\s*(T-\d+|`T-\d+`)\s*\|\s*(.*?)\s*\|?$/.exec(line);
      if (!row || !row[2]) continue;
      const id = row[1].replaceAll('`', '');
      const criterion = row[2].replace(/\\\|/g, '|');
      result[id] = result[id] ? result[id] + '\n' + criterion : criterion;
    }
  }
  return result;
}
