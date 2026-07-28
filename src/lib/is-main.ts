import { pathToFileURL } from 'node:url';

/** True when the module is the entrypoint, so files stay importable by tests. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
