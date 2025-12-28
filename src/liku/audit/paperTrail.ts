import fs from "node:fs";

function isoNow(): string {
  return new Date().toISOString();
}

export function appendTodo(todoPath: string, line: string): void {
  fs.appendFileSync(todoPath, `- [${isoNow()}] ${line}\n`, "utf8");
}

export function appendError(errorsPath: string, title: string, details?: string): void {
  const header = `## ${isoNow()} ${title}\n`;
  const body = details ? `\n${details}\n` : "\n";
  fs.appendFileSync(errorsPath, `${header}${body}\n`, "utf8");
}

