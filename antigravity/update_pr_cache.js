#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoDir = process.argv[2];
const branchName = process.argv[3];
const home = process.env.HOME || '/home/ubuntu';
const cacheFile = path.join(home, '.gemini', 'pr-cache.json');

if (!repoDir || !branchName) {
  process.exit(1);
}

try {
  let prData = null;
  try {
    // Run gh pr view inside the repoDir to fetch PR status for this specific branch
    const stdout = execSync(`gh pr view "${branchName}" --json number,state,title,url,mergeable,mergeStateStatus,statusCheckRollup`, {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 8000
    });
    if (stdout.trim()) {
      prData = JSON.parse(stdout);
    }
  } catch (err) {
    // If it failed (e.g. no PR or network error), mark as NONE or keep old state if it was a temporary network error
    // But to be safe, if we get "no pull requests found", we set state: 'NONE'
    const errMsg = err.message || "";
    if (errMsg.includes("no pull requests found")) {
      prData = { state: 'NONE' };
    } else {
      // For other transient errors (like offline), we can optionally preserve the last state
      // but for simplicity, let's treat it as no PR or keep state NONE.
      prData = { state: 'NONE' };
    }
  }

  // Load existing cache
  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
  }

  // Update entry
  const key = `${repoDir}:${branchName}`;
  cache[key] = {
    number: prData.number || 0,
    state: prData.state || 'NONE',
    title: prData.title || '',
    url: prData.url || '',
    mergeable: prData.mergeable || 'UNKNOWN',
    mergeStateStatus: prData.mergeStateStatus || 'UNKNOWN',
    statusCheckRollup: prData.statusCheckRollup || [],
    updatedAt: Date.now()
  };

  // Keep cache clean (remove entries older than 7 days)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k in cache) {
    if (cache[k] && cache[k].updatedAt < cutoff) {
      delete cache[k];
    }
  }

  // Write cache back
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
} catch (e) {
  // Silent fail
}
