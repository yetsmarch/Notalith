export function validateVaultPath(path: string, configDir: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const protectedDir = configDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const lowerPath = normalized.toLowerCase();
  const lowerDir = protectedDir.toLowerCase();

  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[^/]*:/.test(normalized) ||
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    lowerPath === lowerDir ||
    lowerPath.startsWith(`${lowerDir}/`)
  ) {
    throw new Error(`Unsafe vault path: ${path}`);
  }

  return normalized;
}

export function validateMarkdownPath(path: string, configDir: string): string {
  const normalized = validateVaultPath(path, configDir);
  if (!normalized.endsWith(".md")) {
    throw new Error(`Not a Markdown note path: ${path}`);
  }
  return normalized;
}

export function imageMimeType(extension: string): string | null {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

export function isTextExtension(extension: string): boolean {
  return new Set([
    "md",
    "txt",
    "json",
    "csv",
    "tsv",
    "yaml",
    "yml",
    "xml",
    "html",
    "css",
    "js",
    "ts",
    "log",
    "ini",
    "toml",
  ]).has(extension.toLowerCase());
}

export function validateAttachmentName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/:*?"<>|]/.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error(`Invalid attachment filename: ${name}`);
  }
  return name;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }

  return btoa(binary);
}
