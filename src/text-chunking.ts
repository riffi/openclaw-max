export const MAX_TEXT_CHUNK_LIMIT = 3800;

function splitLongMaxChunk(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut <= 0) {
      cut = limit;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function chunkMaxMarkdownText(text: string, limit = MAX_TEXT_CHUNK_LIMIT): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";
  const paragraphs = normalized.split(/\n{2,}/);

  const flushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    const candidate = current ? `${current}\n\n${trimmedParagraph}` : trimmedParagraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      flushCurrent();
    }

    if (trimmedParagraph.length <= limit) {
      current = trimmedParagraph;
      continue;
    }

    const lines = trimmedParagraph.split("\n");
    for (const line of lines) {
      const trimmedLine = line.trimEnd();
      if (!trimmedLine) {
        continue;
      }
      const lineCandidate = current ? `${current}\n${trimmedLine}` : trimmedLine;
      if (lineCandidate.length <= limit) {
        current = lineCandidate;
        continue;
      }

      if (current) {
        flushCurrent();
      }

      if (trimmedLine.length <= limit) {
        current = trimmedLine;
        continue;
      }

      for (const part of splitLongMaxChunk(trimmedLine, limit)) {
        chunks.push(part);
      }
    }
  }

  if (current) {
    flushCurrent();
  }

  return chunks;
}
