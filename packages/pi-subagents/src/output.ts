const MAX_BYTES = 50_000;
const MAX_LINES = 2_000;

export interface BoundedTextOptions {
  maxBytes?: number;
  maxLines?: number;
  tail?: boolean;
}

export function boundedText(
  value: string,
  options: BoundedTextOptions = {},
): string {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxLines = options.maxLines ?? MAX_LINES;
  const lines = value.split("\n");
  const lineTruncated = lines.length > maxLines;
  let text = options.tail
    ? lines.slice(Math.max(0, lines.length - maxLines)).join("\n")
    : lines.slice(0, maxLines).join("\n");
  let encoded = Buffer.from(text, "utf8");
  if (!lineTruncated && encoded.byteLength <= maxBytes) return text;

  const notice = options.tail
    ? "[Output truncated at start]"
    : "[Output truncated]";
  const noticeBytes = Buffer.byteLength(notice, "utf8") + 1;
  const contentBytes = Math.max(0, maxBytes - noticeBytes);
  encoded = options.tail
    ? encoded.subarray(Math.max(0, encoded.byteLength - contentBytes))
    : encoded.subarray(0, contentBytes);
  text = encoded.toString("utf8");
  return options.tail ? `${notice}\n${text}` : `${text}\n${notice}`;
}

export function formatRunOutput(
  tasks: ReadonlyArray<{
    id: string;
    state: string;
    text: string;
    error?: string;
  }>,
): string {
  const sections = tasks.map((task) => {
    const status = `${task.id}: ${task.state}${task.error ? ` — ${task.error}` : ""}`;
    return task.text ? `${status}\n\n${task.text}` : status;
  });
  return boundedText(sections.join("\n\n---\n\n"));
}
