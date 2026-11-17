#!/usr/bin/env python3
"""redline-guard.py — WorkBuddy PreToolUse mid-flight steering & safety hook.

Exit codes:
  0 = allow tool execution silently
  2 = block tool execution and return stderr reason back into WorkBuddy context

Dynamic rules are read from `live-steering.json` in the same directory
(managed by the `wb_steer_rule` MCP tool / `/api/steer` HTTP API).
"""
import json
import os
import re
import sys

if sys.platform == "win32":
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
STEERING_FILE = os.path.join(HERE, "live-steering.json")

DANGEROUS_PATTERNS = (
    "rm -rf /",
    "rm -rf /etc",
    "mkfs",
    "dd if=/dev/zero of=/dev",
)


def load_steering_rules():
    try:
        with open(STEERING_FILE, encoding="utf-8") as f:
            rules = json.load(f).get("rules", [])
            return [r for r in rules if isinstance(r, dict) and r.get("enabled", True)]
    except Exception:
        return []


def deny(reason):
    print(f"[redline-guard] Blocked: {reason}", file=sys.stderr)
    sys.exit(2)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    cmd = ti.get("command") or ""
    fpath = ti.get("file_path") or ti.get("path") or ""
    text = ""
    if tool in ("Write", "Edit", "MultiEdit"):
        text = ti.get("content") or ""
        if not text and isinstance(ti.get("edits"), list):
            text = " ".join(str(e.get("new_string", "")) for e in ti["edits"] if isinstance(e, dict))

    norm = lambda p: str(p).replace("\\", "/").lower()

    # Built-in safety floor for catastrophic commands
    cmd_lower = cmd.lower()
    for pat in DANGEROUS_PATTERNS:
        if pat in cmd_lower:
            deny(f"Dangerous command pattern: {pat}")

    # Dynamic mid-flight steering rules (live-steering.json)
    for rule in load_steering_rules():
        tools = rule.get("tools") or []
        if tools and tool not in tools:
            continue
        cmd_sub = (rule.get("command_contains") or "").lower()
        path_sub = norm(rule.get("path_contains") or "")
        cont_sub = rule.get("content_contains") or ""
        rx = rule.get("regex") or ""

        matched = True
        if cmd_sub and cmd_sub not in cmd_lower:
            matched = False
        if matched and path_sub and path_sub not in norm(fpath):
            matched = False
        if matched and cont_sub and cont_sub not in text:
            matched = False
        if matched and rx:
            combined = f"{cmd}\n{fpath}\n{text}"
            try:
                if not re.search(rx, combined):
                    matched = False
            except re.error:
                matched = False

        if matched and (cmd_sub or path_sub or cont_sub or rx):
            rid = rule.get("id") or "steer"
            msg = rule.get("message") or "Operation blocked by supervisor steering rule. Please adjust your approach."
            deny(f"[live-steering:{rid}] {msg}")

    sys.exit(0)


if __name__ == "__main__":
    main()
