/**
 * Test isolation.
 *
 * The journal path is resolved when `src/db/index.ts` is first imported, so
 * this must run BEFORE any test file imports it — vitest `setupFiles` do.
 *
 * Without this, every test that seeds or captures appends to the real
 * `data/journal/`, which is a committed durability asset. A test suite run
 * would write thousands of lines describing attempts that never happened, and
 * anyone rebuilding from the journal would get fabricated data. Tests write to
 * a temp directory instead, discarded with the process.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const sandbox = mkdtempSync(resolve(tmpdir(), 'gate-test-'));
process.env['GATE_DATA_DIR'] = sandbox;
process.env['GATE_DB'] = resolve(sandbox, 'unused.db');
