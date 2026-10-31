#!/usr/bin/env node
// Assembles yttd/romfs/ from the downloaded game files + loader.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // ~/workspace/yttd-nx
const app = join(root, 'yttd');
const romfs = join(app, 'romfs');

const copy = (src, dst) => {
  if (!existsSync(src)) { console.log('SKIP (missing):', src); return; }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log('copied', src.replace(root + '/', ''), '->', dst.replace(app + '/', ''));
};

rmSync(romfs, { recursive: true, force: true });

// Loader entry point only. Game files ship separately in the assets ZIP
// (see build-assets.mjs) and are loaded from sdmc:/switch/yourturntodie/assets.
copy(join(app, 'romfs-src', 'main.js'), join(romfs, 'main.js'));
// nx.js runtime config (next to the entrypoint): larger V8 heap for the
// database load, smaller Skia GPU cache.
copy(join(app, 'romfs-src', 'nxjs.ini'), join(romfs, 'nxjs.ini'));

console.log('romfs assembled.');
