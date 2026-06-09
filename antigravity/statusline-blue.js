#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

try {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input.trim()) process.exit(0);

  const data = JSON.parse(input);

  // Dump telemetry to verify structure if needed
  try {
    fs.writeFileSync('/tmp/telemetry_dump.json', JSON.stringify(data, null, 2));
  } catch (e) {}

  const model = data.model?.display_name || "Antigravity";
  const agentKey = "agy";

  // Update CMUX sidebar status dynamically
  try {
    let value = "Ready";
    let icon = "checkmark.circle.fill";
    let color = "#34C759";

    if (data.tool_confirmation_pending) {
      value = "Pending Approval";
      icon = "exclamationmark.triangle.fill";
      color = "#FFB300";
    } else if (data.agent_state === "thinking") {
      value = "Thinking";
      icon = "brain.head.profile";
      color = "#4C8DFF";
    } else if (data.agent_state === "tool_use" || data.agent_state === "working") {
      value = "Working";
      icon = "gearshape.fill";
      color = "#4C8DFF";
    } else if (data.agent_state === "responding") {
      value = "Responding";
      icon = "bubble.left.and.bubble.right.fill";
      color = "#00E5FF";
    } else {
      value = "Idle";
      icon = "pause.circle.fill";
      color = "#8E8E93";
    }

    let cmuxCli = process.env.CMUX_BUNDLED_CLI_PATH || "";
    if (!cmuxCli || !fs.existsSync(cmuxCli)) {
      if (fs.existsSync("/Applications/cmux.app/Contents/Resources/bin/cmux")) {
        cmuxCli = "/Applications/cmux.app/Contents/Resources/bin/cmux";
      } else {
        try {
          cmuxCli = execSync("which cmux 2>/dev/null", { encoding: "utf8" }).trim();
        } catch (e) {}
      }
    }
    if (cmuxCli) {
      let socketPath = process.env.CMUX_SOCKET_PATH || "";
      if (!socketPath && home) {
        socketPath = path.join(home, ".local/state/cmux/cmux.sock");
      }
      const args = [];
      if (socketPath && fs.existsSync(socketPath)) {
        args.push("--socket", socketPath);
      }
      args.push("set-status", agentKey, value);
      const workspaceId = process.env.CMUX_WORKSPACE_ID || "";
      if (workspaceId) {
        args.push("--workspace", workspaceId);
      }
      const windowId = process.env.CMUX_WINDOW_ID || "";
      if (windowId) {
        args.push("--window", windowId);
      }
      args.push("--icon", icon, "--color", color);
      const logFd = fs.openSync('/tmp/cmux_spawn.log', 'w');
      const child = spawn(cmuxCli, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd]
      });
      child.unref();
    }
  } catch (e) {
    fs.writeFileSync('/tmp/statusline_err.log', e.stack || e.message);
  }

  const cwd = data.cwd || process.cwd();

  // Shorten CWD to home-relative path
  const home = process.env.HOME || '/home/ubuntu';
  const cwdShort = cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;

  // Retrieve context window data
  const ctx = data.context_window || {};
  const usedTokens = ctx.total_input_tokens || 0;
  const totalTokens = ctx.context_window_size || 1048576;
  const usedPercent = ctx.used_percentage ? ctx.used_percentage.toFixed(1) : "0.0";

  // Build the progress bar (based on used percentage)
  const barSize = 10;
  const filled = Math.min(barSize, Math.max(0, Math.round((parseFloat(usedPercent) * barSize) / 100)));
  const empty = barSize - filled;
  const bar = "█".repeat(filled);
  const barEmpty = "░".repeat(empty);

  // Helper to format numbers (e.g. 122953 -> 123k, 1048576 -> 1M)
  const formatTokens = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return num;
  };

  // Color Definitions (ANSI)
  const BLUE = "\x1b[1;34m";
  const RESET = "\x1b[0m";
  const GRAY = "\x1b[90m";

  // Calculate Context Cache efficiency (Gemini specific!)
  const cacheRead = ctx.current_usage?.cache_read_input_tokens || 0;
  let hitRate = usedTokens > 0 ? ((cacheRead / usedTokens) * 100) : 0;
  if (hitRate > 100) hitRate = 100.0; // Cap to 100% to handle race conditions in token count propagation
  const cacheHitRate = hitRate.toFixed(1);

  // Build Antigravity telemetry segments
  const cacheStr = ` ${GRAY}|${RESET} ⚡ Cache Hit: ${BLUE}${cacheHitRate}%${RESET}`;

  const outTokens = ctx.total_output_tokens || 0;
  const outStr = outTokens > 0 ? `, Out: ${formatTokens(outTokens)}` : "";

  // Mapping agent state and tool confirmation pending status
  let statusStr = "";
  if (data.tool_confirmation_pending) {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;33m⚠️ Pending Approval\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "thinking") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;34m🤔 Thinking\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "tool_use" || data.agent_state === "working") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;34m⚙️ Working\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "responding") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;36m💬 Responding\x1b[0m\x1b[90m]\x1b[0m`;
  } else {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;32m🟢 Ready\x1b[0m\x1b[90m]\x1b[0m`;
  }

  // Git branch, dirty status, and PR info
  let gitStr = "";
  try {
    // Run all git queries in a single child process to prevent cursor lag
    const cmd = 'git rev-parse --show-toplevel --abbrev-ref HEAD 2>/dev/null && ( [ -n "$(git status --porcelain 2>/dev/null)" ] && echo "dirty" || echo "clean" )';
    const output = execSync(cmd, { cwd, timeout: 350, encoding: 'utf8' }).trim();
    if (output) {
      const lines = output.split('\n');
      if (lines.length >= 2) {
        const repoDir = lines[0].trim();
        const gitBranch = lines[1].trim();
        const isDirty = lines[2] ? lines[2].trim() === "dirty" : false;

        if (repoDir && gitBranch) {
          const dirtyIndicator = isDirty ? "\x1b[1;31m●\x1b[0m" : "";

          // Retrieve cached PR info
          let pr = null;
          const geminiDir = path.join(home, '.gemini');
          const cacheFile = path.join(geminiDir, 'pr-cache.json');
          const cacheKey = `${repoDir}:${gitBranch}`;
          let cache = {};
          if (fs.existsSync(cacheFile)) {
            try {
              cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            } catch (e) {}
          }

          const cachedEntry = cache[cacheKey];
          const now = Date.now();

          // Trigger background cache update if missing or older than 3 minutes (180000ms)
          if (!cachedEntry || (now - cachedEntry.updatedAt > 180000)) {
            try {
              const child = spawn(process.execPath, [
                path.join(__dirname, 'update_pr_cache.js'),
                repoDir,
                gitBranch
              ], {
                detached: true,
                stdio: 'ignore'
              });
              child.unref();
            } catch (e) {}
          }

          if (cachedEntry && cachedEntry.state !== "NONE") {
            pr = cachedEntry;
          }

          // Build the PR badge
          let prStr = "";
          if (pr) {
            if (pr.state === "OPEN") {
              // Determine CI Status
              let ciStatus = 'NONE'; // 'SUCCESS', 'PENDING', 'FAILURE', 'NONE'
              const rollup = pr.statusCheckRollup || [];
              if (rollup.length > 0) {
                let hasFailure = false;
                let hasPending = false;
                let hasSuccess = false;
                for (const check of rollup) {
                  const state = check.state || check.conclusion;
                  const status = check.status;
                  
                  if (state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT') {
                    hasFailure = true;
                  } else if (state === 'PENDING' || status === 'IN_PROGRESS' || status === 'QUEUED' || !state) {
                    hasPending = true;
                  } else if (state === 'SUCCESS') {
                    hasSuccess = true;
                  }
                }
                if (hasFailure) {
                  ciStatus = 'FAILURE';
                } else if (hasPending) {
                  ciStatus = 'PENDING';
                } else if (hasSuccess) {
                  ciStatus = 'SUCCESS';
                }
              }

              const isMergeable = pr.mergeable === "MERGEABLE";
              const hasConflicts = pr.mergeable === "CONFLICTING";

              let prColor = "\x1b[1;32m"; // default to Green
              let prSuffix = "";

              if (ciStatus === 'FAILURE' || hasConflicts) {
                prColor = "\x1b[1;31m"; // Red for blockages
                if (hasConflicts) {
                  prSuffix = " ⚡Conflict";
                } else {
                  prSuffix = " ❌";
                }
              } else if (ciStatus === 'PENDING') {
                prColor = "\x1b[1;33m"; // Yellow for progress
                prSuffix = " ⏳";
              } else if (ciStatus === 'SUCCESS' && isMergeable) {
                prColor = "\x1b[1;32m"; // Green for ready to merge
                prSuffix = " ✅";
              } else {
                prColor = "\x1b[1;32m";
              }

              prStr = ` \x1b[90m(\x1b[0m${prColor}PR #${pr.number}${prSuffix}\x1b[0m\x1b[90m)\x1b[0m`;
            } else if (pr.state === "MERGED") {
              prStr = ` \x1b[90m(\x1b[0m\x1b[1;35mPR #${pr.number} 🟣\x1b[0m\x1b[90m)\x1b[0m`;
            } else if (pr.state === "CLOSED") {
              prStr = ` \x1b[90m(\x1b[0m\x1b[1;31mPR #${pr.number} 🔴\x1b[0m\x1b[90m)\x1b[0m`;
            }
          }

          gitStr = ` ${GRAY}|${RESET} 🌿 ${BLUE}${gitBranch}${dirtyIndicator}${prStr}${RESET}`;
        }
      }
    }
  } catch (e) {
    // Silent fail if git command errors or timeout
  }

  // Print to stdout (two lines)
  console.log(`${BLUE}🤖 ${model}${RESET}${statusStr} ${GRAY}|${RESET} 📂 ${cwdShort}${gitStr}\n${GRAY}└─▶${RESET} Context: [${BLUE}${bar}${GRAY}${barEmpty}${RESET}] ${usedPercent}% (${formatTokens(usedTokens)}/${formatTokens(totalTokens)}${outStr} t)${cacheStr}`);
} catch (e) {
  process.exit(0);
}
