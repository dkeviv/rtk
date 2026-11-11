import { spawn } from "node:child_process";

export const name = "rtk-dsh";

const AWARENESS = `RTK is available. Prefer \`rtk <cmd>\` for commands it supports (git, pytest, cargo test, go test/build, grep, find, docker, kubectl, etc.). Use raw commands when RTK has no filter. \`rtk bypass <cmd>\` runs a command unfiltered but still tracks usage. \`RTK_DISABLED=1 <cmd>\` skips RTK for one command.`;

const FILTERS = [
  [/^pytest\b/, "pytest"],
  [/\s-m\s+pytest\b/, "pytest"],
  [/^cargo\s+test\b/, "cargo-test"],
  [/^go\s+test\b/, "go-test"],
  [/^go\s+build\b/, "go-build"],
  [/^ctest\b/, "ctest"],
  [/^tsc\b/, "tsc"],
  [/^vitest\b/, "vitest"],
  [/^(?:grep|rg)\b/, "grep"],
  [/^(?:find|fd)\b/, "find"],
  [/^git\s+log\b/, "git-log"],
  [/^git\s+diff\b/, "git-diff"],
  [/^git\s+status\b/, "git-status"],
  [/^mypy\b/, "mypy"],
  [/^ruff\s+check\b/, "ruff-check"],
  [/^ruff\s+format\b/, "ruff-format"],
  [/^sqlfluff\s+lint\b/, "sqlfluff-lint"],
  [/^prettier\b/, "prettier"],
  [/^phpunit\b/, "phpunit"],
  [/^(?:pest|paratest)\b/, "php-test"],
  [/^ecs\b/, "ecs"],
  [/^phpstan\b/, "phpstan"],
  [/^pint\b/, "pint"],
];

function filterForCommand(command) {
  const text = String(command ?? "").trim();
  if (!text || text.startsWith("rtk ")) return null;
  for (const [pattern, filter] of FILTERS) if (pattern.test(text)) return filter;
  return null;
}

function singleText(content) {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  return block?.type === "text" && typeof block.text === "string" ? block.text : null;
}

function commandOf(exec) {
  const value = exec?.arguments?.command;
  return typeof value === "string" ? value : null;
}

const MARKER_RE = /^\[(?:exit code|timed out|killed by signal|stopped):/i;

function preserveMarkers(original, filtered) {
  const markers = String(original ?? "").split("\n").filter((line) => MARKER_RE.test(line.trim()));
  if (!markers.length) return filtered;
  const present = new Set(String(filtered ?? "").split("\n").map((line) => line.trim()));
  const missing = markers.filter((line) => !present.has(line.trim()));
  return missing.length ? `${String(filtered).replace(/\s+$/, "")}\n${missing.join("\n")}` : filtered;
}

function runRtkPipe(rtkBin, filter, input, signal, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawn(rtkBin, ["pipe", "-f", filter], { stdio: ["pipe", "pipe", "pipe"] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => finish(null));
    child.on("close", () => finish(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  if (config.awareness !== false && typeof ctx.systemPrompt?.section === "function") {
    try {
      const order = ctx.systemPrompt.getSectionOrder?.("TOOL_BASH") ?? 10000;
      ctx.systemPrompt.section({
        name: "rtk-awareness",
        order,
        interpolate: false,
        text: AWARENESS,
      });
    } catch {
      /* awareness is optional; never block tool filtering */
    }
  }

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision?.kind !== "accept" || result?.isError === true) return decision;
    if (Object.hasOwn(decision, "value")) return decision;
    const original = singleText(decision.content);
    if (original === null || original.length < (config.minChars ?? 800)) return decision;

    const command = commandOf(exec);
    const filter = filterForCommand(command);
    if (!filter) return decision;

    const rtkBin = String(config.rtkBin || process.env.RTK_BIN || "rtk");
    try {
      const filtered = await runRtkPipe(
        rtkBin,
        filter,
        original,
        exec?.signal,
        config.timeoutMs ?? 2000,
      );
      if (!filtered) return decision;
      const text = preserveMarkers(original, filtered).trim();
      if (!text || text.length >= original.length) return decision;
      return { ...decision, kind: "accept", content: [{ type: "text", text }] };
    } catch {
      return decision;
    }
  });
}
