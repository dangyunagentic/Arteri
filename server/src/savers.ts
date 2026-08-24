// Token savers — Arteri's take on 9Router's RTK/Headroom/Caveman/Ponytail.
//
// rtk      : compress TOOL OUTPUT before it goes upstream (git/grep/ls/tree/log filters)
// headroom : strip stale turns / old tool outputs from history (keep last N tool results)
// caveman  : inject a terse-output system prompt (fewer output tokens)
// ponytail : inject lazy-senior-dev system prompt (less code bloat)
// Levels: off | lite | full | ultra (rtk: on/off via level!=off)

export type SaverLevel = "off" | "lite" | "full" | "ultra";

export interface SaversConfig {
  rtk: SaverLevel;
  headroom: SaverLevel;
  caveman: SaverLevel;
  ponytail: SaverLevel;
}

export const DEFAULT_SAVERS: SaversConfig = {
  rtk: "off",
  headroom: "off",
  caveman: "off",
  ponytail: "full", // user runs ponytail full by default
};

const MIN_COMPRESS = 500; // skip tiny blobs
const DETECT_WINDOW = 1024;

type Filter = (text: string) => string;

// ---- generic helpers -------------------------------------------------------
const capLines = (n: number): Filter => (t) => {
  const lines = t.split("\n");
  return lines.length <= n ? t : lines.slice(0, n).join("\n") + `\n... (${lines.length - n} more lines truncated by arteri-rtk)`;
};
const keepHeadTail = (head: number, tail: number): Filter => (t) => {
  const lines = t.split("\n");
  if (lines.length <= head + tail + 1) return t;
  return [
    ...lines.slice(0, head),
    `... (${lines.length - head - tail} lines truncated by arteri-rtk)`,
    ...lines.slice(-tail),
  ].join("\n");
};
const dedup = (): Filter => (t) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of t.split("\n")) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out.join("\n");
};

// ---- content-type detection (first DETECT_WINDOW chars) --------------------
const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_BUILD = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;
const isGrepLine = (l: string) => /^[^:]+:\d+:.+/.test(l);

function detect(text: string): Filter | null {
  const head = text.slice(0, DETECT_WINDOW);
  if (RE_GIT_LOG.test(head)) return capLines(200);
  if (RE_GIT_DIFF.test(head) || RE_GIT_HUNK.test(head))
    return keepHeadTail(120, 60); // diffs: keep head+tail hunks
  if (RE_GIT_STATUS.test(head)) return capLines(40);
  if (RE_BUILD.test(head)) return dedupThen(capLines(80));
  if (RE_TREE.test(head)) return capLines(200);
  if (RE_LS_TOTAL.test(head)) return compressLs;
  const nonEmpty = head.split("\n").filter((l) => l.trim());
  if (nonEmpty.slice(0, 5).some(isGrepLine)) return capLines(50);
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return capLines(30);
  // line-numbered dump -> smart truncate
  if (/^\s*\d+\|/.test(head)) return keepHeadTail(120, 60);
  return null;
}
function dedupThen(f: Filter): Filter {
  return (t) => f(dedup()(t));
}
function isPathLike(l: string): boolean {
  return /^[^\s:]+\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|md|json|ya?ml|toml|sh)$/.test(l.trim()) || /^[.~/]([\w.-]+\/)*[\w.-]+$/.test(l.trim());
}
function compressLs(t: string): string {
  // ls -la -> drop dotfiles noise, collapse to name column when possible
  const lines = t.split("\n");
  if (lines[0]?.startsWith("total ")) lines.shift();
  const names = lines
    .map((l) => l.replace(/^[-dlbcps][rwx-]{9}.*?\s\d\s[\w.-]+\s+[\w.-]+\s+\d+\s+\w{3}\s+\d+\s[\d:]+\s/, ""))
    .filter((n) => n && !/^\.\.?$/.test(n));
  if (!names.length) return t;
  return names.join("\n") + "\n(ls compacted by arteri-rtk)";
}

// ---- public API ------------------------------------------------------------
export function rtkCompress(text: string, level: SaverLevel): { text: string; saved: boolean } {
  if (level === "off" || text.length < MIN_COMPRESS) return { text, saved: false };
  const f = detect(text);
  if (!f) return { text, saved: false };
  const out = f(text);
  return out.length < text.length ? { text: out, saved: true } : { text, saved: false };
}

// history compression: drop old tool outputs entirely, keep recent N
export function headroomTrim(body: any, level: SaverLevel): boolean {
  if (level === "off" || !Array.isArray(body?.messages)) return false;
  const keepRecent = level === "ultra" ? 1 : level === "full" ? 2 : 4;
  let changed = false;
  const msgs: any[] = body.messages;
  // find indices of tool messages (openai) / tool_result blocks (anthropic handled at translate layer)
  const toolIdx = msgs.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  if (toolIdx.length <= keepRecent) return false;
  const cutoff = new Set(toolIdx.slice(0, -keepRecent));
  for (let i = 0; i < msgs.length; i++) {
    if (cutoff.has(i)) {
      msgs[i] = { role: "tool", tool_call_id: msgs[i].tool_call_id, content: "[older output trimmed by arteri-headroom]" };
      changed = true;
    }
  }
  return changed;
}

// ---- system-prompt injectors -------------------------------------------------
const PONYTAIL_LADDER =
  "Before writing code, stop at the first rung that holds: 1) Does this need to exist at all? (YAGNI) 2) Stdlib does it? Use it. 3) Native platform feature covers it? Use it. 4) Already-installed dependency solves it? Use it; never add a new one for what a few lines can do. 5) Can it be one line? One line. 6) Only then: the minimum code that works.";
const PONYTAIL: Record<Exclude<SaverLevel, "off">, string> = {
  lite:
    "You are a lazy senior developer. Lazy means efficient, not careless. Lite: build what's asked, but name the lazier alternative in one line. " +
    PONYTAIL_LADDER,
  full:
    "You are a lazy senior developer. Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation. " +
    PONYTAIL_LADDER +
    " No unrequested abstractions. Deletion over addition. Boring over clever.",
  ultra:
    "You are a lazy senior developer. Ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same response. " +
    PONYTAIL_LADDER,
};
const CAVEMAN: Record<Exclude<SaverLevel, "off">, string> = {
  lite: "Respond tersely. Keep grammar but drop filler, hedging and pleasantries. State the thing, the action, the reason. Then next step.",
  full: "Respond in terse clipped sentences. Drop filler words, pleasantries and hedging. No preamble, no summary of what you're about to do. Code blocks, file paths, commands, errors stay exact.",
  ultra: "Maximum terseness. Telegraphic. No articles or filler. Facts only. Code blocks, file paths, commands, errors stay exact. Security warnings and irreversible-action confirmations stay normal.",
};

export function injectSystem(body: any, text: string): void {
  if (body?.system !== undefined || Array.isArray(body?.messages)) {
    // anthropic-style top-level system
    if (typeof body.system === "string") body.system = text + "\n\n" + body.system;
    else if (Array.isArray(body.system)) body.system = [{ type: "text", text }, ...body.system];
    else if (body.system !== undefined) body.system = text + "\n\n" + String(body.system);
    else {
      // openai: prepend to first system message, else insert one
      const msgs: any[] = body.messages;
      const idx = msgs.findIndex((m) => m.role === "system");
      if (idx >= 0)
        msgs[idx] = { ...msgs[idx], content:
          typeof msgs[idx].content === "string"
            ? text + "\n\n" + msgs[idx].content
            : [{ type: "text", text }, ...(Array.isArray(msgs[idx].content) ? msgs[idx].content : [])],
        };
      else msgs.unshift({ role: "system", content: text });
    }
  }
}

export function applySavers(
  body: any,
  cfg: SaversConfig,
  wire: Protocol2 = "openai"
): void {
  if (cfg.ponytail !== "off") injectSystem(body, PONYTAIL[cfg.ponytail]);
  if (cfg.caveman !== "off") injectSystem(body, CAVEMAN[cfg.caveman]);
  if (cfg.headroom !== "off") headroomTrim(body, cfg.headroom);
  if (cfg.rtk !== "off") rtkToolOutputs(body, cfg.rtk, wire);
}
type Protocol2 = "openai" | "anthropic";

function rtkToolOutputs(body: any, level: SaverLevel, wire: "openai" | "anthropic") {
  const squeeze = (s: string) => rtkCompress(s, level).text;
  if (wire === "anthropic" && Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content)
        if (block?.type === "tool_result" && typeof block.content === "string")
          block.content = squeeze(block.content);
        else if (block?.type === "tool_result" && Array.isArray(block.content))
          for (const c of block.content) if (c.type === "text" && typeof c.text === "string") c.text = squeeze(c.text);
    }
    return;
  }
  if (!Array.isArray(body?.messages)) return;
  for (const m of body.messages as any[]) {
    if (m.role !== "tool" && m.role !== "function") continue;
    if (typeof m.content === "string") m.content = squeeze(m.content);
    else if (Array.isArray(m.content))
      for (const c of m.content) if (c.type === "text" && typeof c.text === "string") c.text = squeeze(c.text);
  }
}
