// Node-runtime replacement for Bun's `$` shell tag and Bun.write/Bun.file, used by
// geetest.ts and stt.ts. Those two files were written against Bun (trawl's own runtime);
// this service runs on Node, which has neither -- same public shape (exitCode/stderr on
// the command result, promise-based file read/write) so the call sites needed no changes
// beyond the import.
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"

export interface ShellResult {
  exitCode: number
  stderr: string
}

export async function runFfmpeg(bin: string, args: string[]): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 32 }, (error, _stdout, stderr) => {
      resolve({
        exitCode: error ? ((error as NodeJS.ErrnoException).code as number | undefined) ?? 1 : 0,
        stderr: stderr?.toString() ?? "",
      })
    })
  })
}

export async function writeFile(path: string, data: Uint8Array | ArrayBuffer): Promise<void> {
  await fs.writeFile(path, data instanceof ArrayBuffer ? new Uint8Array(data) : data)
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buf = await fs.readFile(path)
  return new Uint8Array(buf)
}

export async function rmQuiet(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => fs.unlink(p).catch(() => {})))
}
