import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ValidatedExplicitPath {
  requestedPath: string;
  realPath: string;
  kind: "file" | "directory";
}

/** Validate exactly the path named by the operator. This function never scans a home directory. */
export async function validateExplicitPath(inputPath: string): Promise<ValidatedExplicitPath> {
  if (inputPath.trim().length === 0) throw new Error("--path must not be empty");
  const requestedPath = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
  const linkInfo = await lstat(requestedPath);
  if (linkInfo.isSymbolicLink()) {
    throw new Error(
      "Symbolic-link paths are refused by default; provide the real target path explicitly",
    );
  }
  if (!linkInfo.isFile() && !linkInfo.isDirectory()) {
    throw new Error("--path must identify a regular file or directory");
  }
  return {
    requestedPath,
    realPath: await realpath(requestedPath),
    kind: linkInfo.isFile() ? "file" : "directory",
  };
}
