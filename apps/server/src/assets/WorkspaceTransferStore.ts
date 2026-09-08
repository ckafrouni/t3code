// @effect-diagnostics nodeBuiltinImport:off - native filesystem adapter needs atomic hard links and abortable stream pipelines.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeFS from "node:fs";
import type { WorkspaceUploadInput } from "@t3tools/contracts";

export type UploadTarget = WorkspaceUploadInput & { fingerprint: string | null };
export class TransferFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function fingerprint(stat: Awaited<ReturnType<typeof NodeFSP.stat>>) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
async function inspect(file: string) {
  try {
    return await NodeFSP.lstat(file);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
function within(root: string, target: string) {
  const relative = NodePath.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}
/** Checks every existing ancestor, including symlinks, before creating directories or writing bytes. */
export async function resolveUploadPath(cwd: string, relative: string) {
  if (
    NodePath.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p === ".git" || p.includes("\0"))
  )
    throw new TransferFailure(400, "Choose a file inside the workspace, outside .git.");
  const root = await NodeFSP.realpath(cwd);
  const target = NodePath.join(root, relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = NodePath.join(current, part);
    const stat = await inspect(current);
    if (!stat) break;
    if (stat.isSymbolicLink())
      throw new TransferFailure(409, "Uploads cannot replace or traverse symbolic links.");
    if (!within(root, await NodeFSP.realpath(current)))
      throw new TransferFailure(400, "The destination is outside the workspace.");
  }
  return { root, target };
}
export async function prepareUpload(input: WorkspaceUploadInput) {
  const { root, target } = await resolveUploadPath(input.cwd, input.path);
  const stat = await inspect(target);
  if (stat && !stat.isFile() && !stat.isDirectory())
    throw new TransferFailure(409, "The destination is not a regular file or directory.");
  if (stat?.isDirectory() && input.kind === "directory" && input.conflict === "replace")
    return { _tag: "skipped" as const };
  if (stat && input.conflict === "skip") return { _tag: "skipped" as const };
  if (stat && input.conflict === "ask")
    return {
      _tag: "conflict" as const,
      path: input.path,
      kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
    };
  if (stat && input.conflict === "replace" && (stat.isDirectory() || input.kind === "directory"))
    throw new TransferFailure(
      409,
      "Replacing a folder with a file, or a file with a folder, is not supported. Choose Keep both.",
    );
  return {
    _tag: "target" as const,
    target: { ...input, cwd: root, fingerprint: stat ? fingerprint(stat) : null },
  };
}
const commits = new Map<string, Promise<void>>();
async function withCommitLock<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = commits.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => {
    release = r;
  });
  const next = previous.then(() => done);
  commits.set(key, next);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (commits.get(key) === next) commits.delete(key);
  }
}
/** Stages on the destination filesystem and publishes only complete files. Cancellation removes the stage. */
export async function receiveUpload(
  claim: UploadTarget,
  bytes: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
) {
  const { root, target } = await resolveUploadPath(claim.cwd, claim.path);
  const parent = NodePath.dirname(target);
  await NodeFSP.mkdir(parent, { recursive: true });
  await resolveUploadPath(root, claim.path);
  const staging = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-upload-"));
  const temporary = NodePath.join(staging, NodeCrypto.randomUUID());
  try {
    let received = 0;
    async function* counted() {
      for await (const chunk of bytes) {
        received += chunk.byteLength;
        if (received > claim.sizeBytes)
          throw new TransferFailure(413, "Upload exceeds its declared size.");
        yield chunk;
      }
      if (received !== claim.sizeBytes)
        throw new TransferFailure(400, "Upload ended before all bytes arrived.");
    }
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.from(counted()),
      NodeFS.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      ...(signal ? [{ signal }] : []),
    );
    signal?.throwIfAborted();
    return await withCommitLock(target, async () => {
      signal?.throwIfAborted();
      await resolveUploadPath(root, claim.path);
      const current = await inspect(target);
      if (
        claim.conflict !== "keep-both" &&
        (current ? fingerprint(current) : null) !== claim.fingerprint
      )
        throw new TransferFailure(
          409,
          "The destination changed during upload. Retry to review the conflict.",
        );
      if (claim.kind === "directory") {
        if (claim.sizeBytes !== 0)
          throw new TransferFailure(400, "Directory uploads must be empty.");
        for (let i = 0; i < 10000; i++) {
          const dest = i === 0 ? target : `${target} (${i})`;
          try {
            await NodeFSP.mkdir(dest);
            return { path: NodePath.relative(root, dest).split(NodePath.sep).join("/") };
          } catch (e) {
            if (
              !(
                e instanceof Error &&
                "code" in e &&
                e.code === "EEXIST" &&
                claim.conflict === "keep-both"
              )
            )
              throw e;
          }
        }
      } else if (claim.conflict === "replace" && current) {
        await NodeFSP.rename(temporary, target);
        return { path: claim.path };
      } else {
        const ext = NodePath.extname(target),
          base = target.slice(0, target.length - ext.length);
        for (let i = 0; i < 10000; i++) {
          const dest = i === 0 ? target : `${base} (${i})${ext}`;
          try {
            await NodeFSP.link(temporary, dest);
            return { path: NodePath.relative(root, dest).split(NodePath.sep).join("/") };
          } catch (e) {
            if (
              !(
                e instanceof Error &&
                "code" in e &&
                e.code === "EEXIST" &&
                claim.conflict === "keep-both"
              )
            )
              throw e;
          }
        }
      }
      throw new TransferFailure(409, "No available destination name.");
    });
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}
