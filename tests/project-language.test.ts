import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(relative: string): string[] {
  const absolute = path.join(root, relative);
  if (!fs.statSync(absolute).isDirectory()) return [relative];
  return fs.readdirSync(absolute).flatMap((name) => sourceFiles(path.join(relative, name)));
}

describe("English project language", () => {
  it("does not reintroduce Chinese or Vietnamese prose in maintained project files", () => {
    // This catches the languages removed in the English-only migration, not
    // every possible non-English sentence. Unicode behavior fixtures may use
    // escaped code points without removing their runtime coverage.
    const removedLanguage = /[\p{Script=Han}\u0102\u0103\u0110\u0111\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9\u3000-\u303f\uff01-\uff60]/u;
    const files = ["README.md", "docs", "skill", "src", "tests", "scripts", "bin", "examples"]
      .flatMap(sourceFiles);
    const violations = files.flatMap((file) => fs.readFileSync(path.join(root, file), "utf8")
      .split("\n").flatMap((line, index) => removedLanguage.test(line) ? [`${file}:${index + 1}`] : []));
    expect(violations).toEqual([]);
  });

  it("keeps a single English README and an English dashboard document", () => {
    expect(fs.readdirSync(root).filter((name) => /^README(?:\..+)?\.md$/i.test(name)))
      .toEqual(["README.md"]);
    expect(fs.readFileSync(path.join(root, "src/dashboard/page.ts"), "utf8"))
      .toContain('<html lang="en">');
  });
});
