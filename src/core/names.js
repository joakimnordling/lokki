// Metric names: Unicode NFC, invisible characters removed, runs of spaces collapsed, so look-alike names count as the same.
export const normName = (s) =>
  String(s || "")
    .normalize("NFC")
    .replace(/[​-‏⁠-⁤﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
export const sameName = (a, b) => normName(a).toLowerCase() === normName(b).toLowerCase();
// File names for exports: characters that file systems refuse are replaced.
export const safeFile = (name) =>
  normName(name)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    .replace(/[/\\:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "") || "metric";
