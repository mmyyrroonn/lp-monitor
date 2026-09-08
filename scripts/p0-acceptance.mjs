// Compatibility entry point. Never overwrite or relabel the historical acceptance.
console.error(
  'p0-acceptance.mjs is a compatibility alias for historical archive audit; current source is not validated. Use audit-p0-archive.mjs.',
);
await import('./audit-p0-archive.mjs');
