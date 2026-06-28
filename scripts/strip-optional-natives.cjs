#!/usr/bin/env node
/**
 * Prepare native modules so electron-builder's rebuild step can complete on a
 * machine WITHOUT a C++ toolchain (Visual Studio) and WITH a space in the
 * project path ("ECS 2026"). Both conditions break node-gyp source compiles.
 *
 * Strategy: only `better-sqlite3` actually needs an Electron-ABI binary, and it
 * gets one via prebuilt download. The other native modules either aren't needed
 * or already ship Electron-compatible (N-API) prebuilt binaries, so we stop
 * @electron/rebuild from trying to compile them from source.
 *
 *  1. cpu-features  — OPTIONAL dep of ssh2 (crypto speed-up only). ssh2 loads it
 *     in a try/catch and runs fine without it. We delete it entirely.
 *
 *  2. node-pty      — N-API module (depends on node-addon-api). Its prebuilt
 *     binaries in prebuilds/<platform>-<arch> are ABI-stable and load directly
 *     in Electron. binding.gyp is only used for source compiles, never at
 *     runtime, so we rename it to make @electron/rebuild skip the module.
 */
const fs = require('node:fs');
const path = require('node:path');

const nm = path.join(__dirname, '..', 'node_modules');

// 1) Remove optional native modules that have no usable prebuilt binary.
for (const name of ['cpu-features']) {
  const dir = path.join(nm, name);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[strip-optional-natives] removed node_modules/${name}`);
    } else {
      console.log(`[strip-optional-natives] node_modules/${name} not present, skipping`);
    }
  } catch (err) {
    console.warn(`[strip-optional-natives] could not remove ${name}: ${err.message}`);
  }
}

// 2) Skip source-rebuild for modules that already ship Electron-compatible
//    (N-API) prebuilt binaries, by hiding their binding.gyp.
for (const name of ['node-pty']) {
  const gyp = path.join(nm, name, 'binding.gyp');
  const disabled = gyp + '.disabled';
  try {
    if (fs.existsSync(gyp)) {
      fs.renameSync(gyp, disabled);
      console.log(`[strip-optional-natives] disabled ${name}/binding.gyp (use prebuilt N-API binary)`);
    } else if (fs.existsSync(disabled)) {
      console.log(`[strip-optional-natives] ${name}/binding.gyp already disabled, skipping`);
    } else {
      console.log(`[strip-optional-natives] ${name}/binding.gyp not found, skipping`);
    }
  } catch (err) {
    console.warn(`[strip-optional-natives] could not disable ${name}/binding.gyp: ${err.message}`);
  }
}
