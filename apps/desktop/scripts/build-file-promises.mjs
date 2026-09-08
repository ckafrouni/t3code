/* oxlint-disable t3code/no-global-process-runtime -- This native compiler script targets the actual host and has no Effect runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string" } },
});
if (process.platform === "darwin") {
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const source = NodePath.join(root, "native/file-promises/main.mm");
  const output =
    values.output ??
    NodePath.join(root, "apps/desktop/resources/file-promises/t3-file-promises.node");
  const architectures =
    values.arch === "arm64" ? ["arm64"] : values.arch === "x64" ? ["x86_64"] : ["arm64", "x86_64"];
  if (values.arch && !["arm64", "x64", "universal"].includes(values.arch))
    throw new Error(`Unsupported Mac architecture: ${values.arch}`);
  let matchesArchitecture = false;
  if (NodeFS.existsSync(output)) {
    try {
      NodeChildProcess.execFileSync("xcrun", ["lipo", "-verify_arch", ...architectures, output], {
        stdio: "ignore",
      });
      matchesArchitecture = true;
    } catch {
      /* Rebuild for the requested architecture. */
    }
  }
  if (
    !matchesArchitecture ||
    NodeFS.statSync(output).mtimeMs <
      Math.max(
        NodeFS.statSync(source).mtimeMs,
        NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
      )
  ) {
    const include = [
      process.env.T3_NODE_HEADERS,
      NodePath.join(
        NodeOS.homedir(),
        "Library/Caches/node-gyp",
        process.versions.node,
        "include/node",
      ),
      "/opt/homebrew/include/node",
      "/usr/local/include/node",
    ]
      .filter(Boolean)
      .find((p) => NodeFS.existsSync(NodePath.join(p, "node_api.h")));
    if (!include)
      throw new Error(
        "Node headers are required to build Mac file dragging. Run: npx node-gyp install",
      );
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const tmp = `${output}.${process.pid}.tmp`;
    try {
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "clang++",
          "-std=c++17",
          "-fobjc-arc",
          "-shared",
          "-undefined",
          "dynamic_lookup",
          "-framework",
          "Cocoa",
          "-I",
          include,
          ...architectures.flatMap((a) => ["-arch", a]),
          "-mmacosx-version-min=12.0",
          source,
          "-o",
          tmp,
        ],
        { stdio: "inherit" },
      );
      NodeFS.renameSync(tmp, output);
    } finally {
      NodeFS.rmSync(tmp, { force: true });
    }
  }
}
