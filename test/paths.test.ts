import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRepoRoot, normalizeAgentResidence, isSubpath, resolveLikuPaths } from "../src/liku/paths.js";
import { LikuError } from "../src/liku/errors.js";

describe("paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-paths-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("validateRepoRoot", () => {
    it("accepts valid directory", () => {
      expect(() => validateRepoRoot(tmpDir)).not.toThrow();
    });

    it("throws INVALID_REPO_ROOT for non-existent path", () => {
      const nonExistent = path.join(tmpDir, "does-not-exist");
      expect(() => validateRepoRoot(nonExistent)).toThrow(LikuError);

      try {
        validateRepoRoot(nonExistent);
      } catch (err) {
        expect((err as LikuError).code).toBe("INVALID_REPO_ROOT");
      }
    });

    it("throws INVALID_REPO_ROOT for file path", () => {
      const filePath = path.join(tmpDir, "file.txt");
      fs.writeFileSync(filePath, "content");

      expect(() => validateRepoRoot(filePath)).toThrow(LikuError);

      try {
        validateRepoRoot(filePath);
      } catch (err) {
        expect((err as LikuError).code).toBe("INVALID_REPO_ROOT");
      }
    });
  });

  describe("normalizeAgentResidence", () => {
    let likuRoot: string;

    beforeEach(() => {
      likuRoot = path.join(tmpDir, "Liku");
      fs.mkdirSync(likuRoot, { recursive: true });
    });

    it("accepts valid relative path under Liku/", () => {
      const result = normalizeAgentResidence("Liku/specialist/ts", tmpDir, likuRoot);
      expect(result).toBe(path.join(tmpDir, "Liku", "specialist", "ts"));
    });

    it("throws PATH_TRAVERSAL for absolute path", () => {
      expect(() => normalizeAgentResidence("/absolute/path", tmpDir, likuRoot)).toThrow(LikuError);

      try {
        normalizeAgentResidence("/absolute/path", tmpDir, likuRoot);
      } catch (err) {
        expect((err as LikuError).code).toBe("PATH_TRAVERSAL");
      }
    });

    it("throws PATH_TRAVERSAL for .. traversal", () => {
      expect(() => normalizeAgentResidence("Liku/../../../etc", tmpDir, likuRoot)).toThrow(LikuError);

      try {
        normalizeAgentResidence("Liku/../../../etc", tmpDir, likuRoot);
      } catch (err) {
        expect((err as LikuError).code).toBe("PATH_TRAVERSAL");
      }
    });

    it("throws INVALID_RESIDENCE for path outside Liku/", () => {
      expect(() => normalizeAgentResidence("src/code", tmpDir, likuRoot)).toThrow(LikuError);

      try {
        normalizeAgentResidence("src/code", tmpDir, likuRoot);
      } catch (err) {
        expect((err as LikuError).code).toBe("INVALID_RESIDENCE");
      }
    });

    it("normalizes path separators", () => {
      const result = normalizeAgentResidence("Liku/specialist/ts", tmpDir, likuRoot);
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe("isSubpath", () => {
    it("returns true for same path", () => {
      expect(isSubpath(tmpDir, tmpDir)).toBe(true);
    });

    it("returns true for child path", () => {
      const child = path.join(tmpDir, "sub", "dir");
      expect(isSubpath(tmpDir, child)).toBe(true);
    });

    it("returns false for parent path", () => {
      const parent = path.dirname(tmpDir);
      expect(isSubpath(tmpDir, parent)).toBe(false);
    });

    it("returns false for sibling path", () => {
      const sibling = path.join(path.dirname(tmpDir), "sibling");
      expect(isSubpath(tmpDir, sibling)).toBe(false);
    });

    it("handles .. in child path", () => {
      const child = path.join(tmpDir, "sub", "..", "other");
      expect(isSubpath(tmpDir, child)).toBe(true);
    });

    it("handles .. that escapes parent", () => {
      const escaped = path.join(tmpDir, "..", "other");
      expect(isSubpath(tmpDir, escaped)).toBe(false);
    });
  });

  describe("resolveLikuPaths", () => {
    it("returns all expected paths", () => {
      const paths = resolveLikuPaths(tmpDir);

      expect(paths.repoRoot).toBe(path.resolve(tmpDir));
      expect(paths.likuRoot).toBe(path.resolve(tmpDir, "Liku"));
      expect(paths.rootSupervisorDir).toBe(path.resolve(tmpDir, "Liku", "root"));
      expect(paths.specialistsDir).toBe(path.resolve(tmpDir, "Liku", "specialist"));
      expect(paths.memoryDir).toBe(path.resolve(tmpDir, "Liku", "memory"));
    });

    it("handles relative paths", () => {
      const paths = resolveLikuPaths(".");
      expect(path.isAbsolute(paths.repoRoot)).toBe(true);
      expect(path.isAbsolute(paths.likuRoot)).toBe(true);
    });
  });
});
