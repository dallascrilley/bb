---
title: Metro cannot resolve Expo Router when node_modules points outside the workspace
date: 2026-08-29
category: runtime-errors
module: mobile-metro
tags: [android, expo-router, metro, pnpm, symlinks]
severity: medium
---

# Metro cannot resolve Expo Router when node_modules points outside the workspace

## Problem

The Android development client received HTTP 404 for:

```text
http://127.0.0.1:8081/apps/mobile/node_modules/expo-router/entry.bundle
```

Metro reported:

```text
Unable to resolve module ./apps/mobile/node_modules/expo-router/entry from /Users/dallascrilley/Code/oss/bb/.
```

The file existed through a pnpm symlink, but its physical target was under `/Volumes/ExternalSSD/Developer/bb/node_modules`, outside Metro's configured watch roots.

## What didn't work

Restarting `expo start --dev-client` from `apps/mobile`, both through the pnpm script and the Expo binary directly, reproduced the same 404. Changing the launch wrapper could not change Metro's filesystem visibility.

## Solution

In `apps/mobile/metro.config.js:8-22`, resolve the configured `nodeModulesPaths` to their physical paths, retain those outside the logical workspace, and add them to `config.watchFolders`:

```js
const externalNodeModulesPaths = nodeModulesPaths
  .map((nodeModulesPath) => fs.realpathSync(nodeModulesPath))
  .filter(
    (nodeModulesPath) =>
      !nodeModulesPath.startsWith(`${workspaceRoot}${path.sep}`),
  );

config.watchFolders = [workspaceRoot, ...externalNodeModulesPaths];
```

Keep the logical paths in `config.resolver.nodeModulesPaths`; only the watch roots need the physical external locations.

## Why it works

Metro only resolves files visible under its project and watch roots. pnpm symlinks can name a package inside the workspace while placing the real file tree elsewhere, so adding the physical dependency root makes `expo-router/entry.js` visible without changing package resolution.

## Prevention

When Metro says a symlinked module does not exist, compare `realpath node_modules` and the package's real path with `config.watchFolders` before changing Expo project roots or rebuilding the native client. Verify the fix by loading the exact Android bundle through the device, not only by checking that Metro starts.
