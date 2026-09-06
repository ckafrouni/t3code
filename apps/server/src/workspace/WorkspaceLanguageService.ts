// @effect-diagnostics globalTimers:off -- This Node process adapter owns and clears its request and idle deadlines.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  LanguageServiceError,
  type LanguageRequest,
  type LanguageResult,
} from "@t3tools/contracts";
import { TypeScriptLanguageBackend } from "./TypeScriptLanguageBackend.ts";
import { JsonLanguageBackend } from "./JsonLanguageBackend.ts";
import { LspLanguageBackend } from "./LspLanguageBackend.ts";
import type { LanguageBackend } from "./LanguageBackend.ts";
import { codeLanguageForPath } from "@t3tools/contracts";

interface EditorSession {
  server: LanguageBackend;
  cwd: string;
  file: string;
  contents: string;
  version: number;
  tail: Promise<unknown>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** Connection-scoped, with separate unsaved buffers for each editor. Nothing is written to disk. */
export class WorkspaceLanguageService {
  private readonly sessions = new Map<string, EditorSession>();
  private disposed = false;

  async request(input: LanguageRequest): Promise<LanguageResult> {
    if (this.disposed)
      throw new LanguageServiceError({ message: "Connection closed.", resync: false });
    let session = this.sessions.get(input.sessionId);
    if (input.operation === "close") {
      if (session) this.remove(input.sessionId, session);
      return { _tag: "closed" };
    }
    if (session?.server.closed) {
      this.remove(input.sessionId, session);
      session = undefined;
    }
    if (!session) {
      if (input.update?._tag !== "open")
        throw new LanguageServiceError({ message: "Editor session expired.", resync: true });
      const language = codeLanguageForPath(input.relativePath);
      if (!language) throw new Error("Language features are not available for this file type.");
      const cwd = await NodeFSP.realpath(input.cwd);
      const file = await NodeFSP.realpath(NodePath.resolve(cwd, input.relativePath));
      const relative = NodePath.relative(cwd, file);
      if (
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative)
      )
        throw new Error("Editor file must be inside the workspace.");
      if (this.disposed) throw new Error("Connection closed.");
      // Recheck after filesystem awaits; simultaneous opens must not orphan a process.
      session = this.sessions.get(input.sessionId);
      if (!session) {
        if (this.sessions.size >= 4)
          throw new Error("Too many active code editors. Close an editor and retry.");
        const server =
          language === "typescript" || language === "javascript"
            ? new TypeScriptLanguageBackend(cwd, file)
            : language === "json" || language === "jsonc"
              ? new JsonLanguageBackend(cwd, file, language)
              : new LspLanguageBackend(cwd, file, language);
        session = {
          server,
          cwd: input.cwd,
          file,
          contents: "",
          version: -1,
          tail: Promise.resolve(),
          idle: undefined,
        };
        this.sessions.set(input.sessionId, session);
      }
    }
    const current = session;
    if (
      current.cwd !== input.cwd ||
      NodePath.resolve(input.cwd, input.relativePath) !== current.file
    ) {
      // realpath may have resolved a symlink within the workspace.
      if (
        current.cwd !== input.cwd ||
        (await NodeFSP.realpath(NodePath.resolve(input.cwd, input.relativePath))) !== current.file
      )
        throw new Error("Editor session belongs to a different file.");
    }
    clearTimeout(current.idle);
    const task = current.tail.then(async () => {
      await this.synchronize(current, input);
      if (input.operation === "refresh" && codeLanguageForPath(current.file) === "protobuf") {
        // Buf caches imported files for the process lifetime. Reload only on workspace changes.
        current.server.dispose();
        current.server = new LspLanguageBackend(
          await NodeFSP.realpath(current.cwd),
          current.file,
          "protobuf",
        );
        await current.server.update(current.contents, current.version);
      }
      return current.server.query(input);
    });
    current.tail = task.catch(() => undefined);
    try {
      return await task;
    } finally {
      if (this.sessions.get(input.sessionId) === current) {
        clearTimeout(current.idle);
        current.idle = setTimeout(() => this.remove(input.sessionId, current), 5 * 60_000);
        current.idle.unref();
      }
    }
  }

  private async synchronize(session: EditorSession, input: LanguageRequest) {
    const update = input.update;
    if (update?._tag === "open") {
      await session.server.update(update.contents, input.version);
      session.contents = update.contents;
      session.version = input.version;
    } else if (update?._tag === "change") {
      if (update.baseVersion !== session.version || input.version <= session.version)
        throw new LanguageServiceError({
          message: "Editor changed. Resynchronizing.",
          resync: true,
        });
      if (update.start + update.deleteLength > session.contents.length)
        throw new Error("Invalid editor change range.");
      const contents =
        session.contents.slice(0, update.start) +
        update.text +
        session.contents.slice(update.start + update.deleteLength);
      if (contents.length > 1024 * 1024)
        throw new Error("File is too large for language features.");
      await session.server.update(contents, input.version, update);
      session.contents = contents;
      session.version = input.version;
    } else if (input.version !== session.version) {
      throw new LanguageServiceError({ message: "Editor changed. Resynchronizing.", resync: true });
    }
  }

  private remove(id: string, session: EditorSession) {
    clearTimeout(session.idle);
    session.server.dispose();
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }

  dispose() {
    this.disposed = true;
    for (const [id, session] of this.sessions) this.remove(id, session);
  }
}
