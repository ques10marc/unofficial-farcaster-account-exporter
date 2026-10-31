#!/usr/bin/env node
// Runs the TypeScript sources directly with Node's built-in type stripping (Node >= 24), so a fresh
// clone needs no build step: npm ci, then node bin/castsnap.js ...
import '../src/cli.ts';
