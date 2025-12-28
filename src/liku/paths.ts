import path from "node:path";
import fs from "node:fs";
import { LikuError } from "./errors.js";

export type LikuPaths = {
  repoRoot: string;
  likuRoot: string;
  rootSupervisorDir: string;
  specialistsDir: string;
  memoryDir: string;
};

export function resolveLikuPaths(repoRoot: string): LikuPaths {
  const likuRoot = path.resolve(repoRoot, "Liku");
  return {
    repoRoot: path.resolve(repoRoot),
    likuRoot,
    rootSupervisorDir: path.resolve(likuRoot, "root"),
    specialistsDir: path.resolve(likuRoot, "specialist"),
    memoryDir: path.resolve(likuRoot, "memory")
  };
}

export function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Validates that the given path is a valid directory.
 * @throws LikuError with INVALID_REPO_ROOT if validation fails.
 */
export function validateRepoRoot(repoRoot: string): void {
  const resolved = path.resolve(repoRoot);
  if (!fs.existsSync(resolved)) {
    throw new LikuError("INVALID_REPO_ROOT", `Repo root does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new LikuError("INVALID_REPO_ROOT", `Repo root is not a directory: ${resolved}`);
  }
}

/**
 * Normalizes and validates an agent residence path.
 * - Rejects absolute paths
 * - Rejects path traversal (.. components)
 * - Ensures path is under Liku/
 * @returns The normalized absolute path under likuRoot.
 * @throws LikuError with PATH_TRAVERSAL or INVALID_RESIDENCE on invalid input.
 */
export function normalizeAgentResidence(
  agentResidence: string,
  repoRoot: string,
  likuRoot: string
): string {
  // Reject absolute paths
  if (path.isAbsolute(agentResidence)) {
    throw new LikuError(
      "PATH_TRAVERSAL",
      `Agent residence must be a relative path, got absolute: ${agentResidence}`
    );
  }

  // Normalize and check for .. traversal
  const normalized = path.normalize(agentResidence);
  if (normalized.includes("..")) {
    throw new LikuError("PATH_TRAVERSAL", `Agent residence contains path traversal: ${agentResidence}`);
  }

  // Resolve to absolute path
  const resolved = path.resolve(repoRoot, normalized);

  // Must be under Liku/
  if (!isSubpath(likuRoot, resolved)) {
    throw new LikuError(
      "INVALID_RESIDENCE",
      `Agent residence must resolve under Liku/: ${agentResidence}`
    );
  }

  return resolved;
}

