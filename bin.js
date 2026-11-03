#!/usr/bin/env node
// pnpm links the bin at install time, before anything is built, so it cannot live in dist/.
import './dist/cli.js';
