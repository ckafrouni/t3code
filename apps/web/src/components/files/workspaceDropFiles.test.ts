import { describe, expect, it } from "vite-plus/test";
import { readWorkspaceDrop } from "./workspaceDropFiles";
function directory(name: string, pages: unknown[][]) {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader() {
      let page = 0;
      return {
        readEntries(resolve: (entries: unknown[]) => void) {
          resolve(pages[page++] ?? []);
        },
      };
    },
  };
}
function file(name: string) {
  return {
    name,
    isDirectory: false,
    isFile: true,
    file(resolve: (value: File) => void) {
      resolve(new File([name], name));
    },
  };
}
function data(entry: unknown) {
  return {
    items: [{ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null }],
    files: [],
  } as unknown as DataTransfer;
}
describe("workspace folder drops", () => {
  it("reads every directory page and retains empty directories before their children", async () => {
    const page = Array.from({ length: 100 }, (_, n) => file(`${n}.txt`));
    const result = await readWorkspaceDrop(
      data(
        directory("folder", [
          page,
          [directory("empty", []), directory("nested", [[file("last.txt")]])],
        ]),
      ),
    );
    expect(result.length).toBe(104);
    expect(result[0]).toEqual({ path: "folder", file: null });
    expect(result.at(-3)).toEqual({ path: "folder/empty", file: null });
    expect(result.at(-2)).toEqual({ path: "folder/nested", file: null });
    expect(await result.at(-1)?.file?.text()).toBe("last.txt");
    expect(result.at(-1)?.path).toBe("folder/nested/last.txt");
  });
  it("rejects repository metadata before any upload starts", async () => {
    await expect(
      readWorkspaceDrop(data(directory("folder", [[directory(".git", [])]]))),
    ).rejects.toThrow(".git");
  });
  it("supports browsers without directory-entry APIs", async () => {
    const value = new File(["text"], "report.txt");
    const result = await readWorkspaceDrop({
      items: [{ kind: "file", getAsFile: () => value }],
      files: [value],
    } as unknown as DataTransfer);
    expect(result).toEqual([{ path: "report.txt", file: value }]);
  });
});
