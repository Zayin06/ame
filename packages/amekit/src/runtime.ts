// Adapted from opencode-amekit/src/runtime.ts; see ../docs/amekit.md for provenance.
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { safeDirectory } from "./installer"
import path from "node:path"
import { privateEnvironment } from "../../opencode-adapter/src/runtime"

export type Catalog = { agents: { id: string }[]; skills: { id: string; name: string; path: string }[] }
export type Expected = { agents: string[]; skills: string[] }
export type Discover = (directory: string, signal?: AbortSignal, expected?: Expected) => Promise<Catalog>
export function runtimeDiscovery(cli: string | undefined, storage: string): Discover {
  return async (directory, signal, expected) => {
    signal?.throwIfAborted()
    if (!cli || !path.isAbsolute(cli)) throw new Error("CLI_UNAVAILABLE")
    const version = await promisify(execFile)(cli, ["--version"], { windowsHide: true, timeout: 10_000, maxBuffer: 4096, signal }).catch(() => { throw new Error("CLI_UNAVAILABLE") })
    if (!/^(?:opencode v)?2\.3\.2$/.test(version.stdout.trim())) throw new Error("UNTESTED_CLI_VERSION")
    await mkdir(storage, { recursive: true })
    await safeDirectory(storage)
    const temporary = await mkdtemp(path.join(storage, "discovery-"))
    await Promise.all(['config/opencode', 'data', 'cache', 'state', 'home'].map(folder => mkdir(path.join(temporary, folder), { recursive: true })))
    const command = [cli]
    const password = randomBytes(32).toString("base64url")
    const child = spawn(command[0], [...command.slice(1), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...privateEnvironment(temporary, password), OPENCODE_DB: path.join(temporary, "discovery.db"),
        OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FILEWATCHER: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ snapshots: false, warming: false, policies: [
          { action: "plugin.use", resource: "*", effect: "deny" },
          { action: "mcp.use", resource: "*", effect: "deny" },
          { action: "tool.use", resource: "*", effect: "deny" },
        ] }) },
    })
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()) })
    const deadline = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])])
    const abort = () => child.kill()
    deadline.addEventListener("abort", abort, { once: true })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buffer = ""
        const fail = () => reject(new Error("DISCOVERY_START_FAILED"))
        deadline.addEventListener("abort", fail, { once: true })
        child.once("error", fail); child.once("exit", fail)
        child.stderr.on("data", () => {})
        child.stdout.on("data", chunk => {
          buffer = (buffer + chunk.toString()).slice(-4096)
          const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
          if (match) { deadline.removeEventListener("abort", fail); resolve(match[1]) }
        })
      })
      const get = async (endpoint: string) => {
        const query = new URLSearchParams({ "location[directory]": directory })
        const response = await fetch(`${url}/api/${endpoint}?${query}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: deadline, redirect: "error" })
        if (!response.ok) throw new Error("DISCOVERY_HTTP_ERROR")
        return response.json() as Promise<{ data: unknown[] }>
      }
      await get("plugin")
      let result: Catalog = { agents: [], skills: [] }
      for (let attempt = 0; attempt < 80; attempt++) {
        const [agents, skills] = await Promise.all([get("agent"), get("skill")])
        result = { agents: agents.data as Catalog["agents"], skills: skills.data as Catalog["skills"] }
        const ready = !expected || (expected.agents.every(id => result.agents.some(a => a.id === id)) && expected.skills.every(id => result.skills.some(s => s.name === id)))
        if (attempt >= 12 && result.agents.length && ready) return result
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error("DISCOVERY_EMPTY")
    } finally {
      deadline.removeEventListener("abort", abort)
      child.kill()
      await closed
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
