import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  evidencePathRoot,
  resolveEvidencePath,
  relativeEvidencePath,
  safeDiagnostic,
} from './evidence-paths.mjs';
let phase = 'manifest';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
try {
  if (!process.argv[2]) throw new Error('manifest path required');
  const manifestPath = resolve(process.argv[2]);
  const fixture = read(manifestPath);
  phase = 'historical supporting reports';
  const acceptancePath = resolve('artifacts/p0/acceptance.json');
  const acceptance = read(acceptancePath);
  const acceptanceRoot = evidencePathRoot(acceptance.pathBase, acceptancePath);
  const fixtureRoot = evidencePathRoot(fixture.pathBase, manifestPath);
  const officialPath = resolve('artifacts/p0/official-source-evidence.json');
  const official = read(officialPath);
  // This legacy archive predates explicit pathBase on official-source-evidence.
  const officialRoot = evidencePathRoot(official.pathBase ?? 'repository', officialPath);
  const archiveFiles = acceptance.evidence.map((file) => ({
    ...file,
    absolutePath: resolveEvidencePath(acceptanceRoot, file.path),
  }));
  const identityMetadataPath = resolve('artifacts/p0/identity-evidence-path-metadata.json');
  const identityMetadata = read(identityMetadataPath);
  phase = 'historical archive hashes';
  const gates = {
    identityPathMetadata:
      identityMetadata.pathBase === 'repository' &&
      identityMetadata.path === 'artifacts/p0/identity-evidence.json' &&
      identityMetadata.sha256 ===
        sha256(readFileSync(resolveEvidencePath(process.cwd(), identityMetadata.path))),
    historicalAcceptanceRecordedPassed:
      acceptance.passed === true &&
      Object.keys(acceptance.gates).length > 0 &&
      Object.values(acceptance.gates).every((value) => value === true),
    manifestBoundToHistoricalAcceptance: archiveFiles.some(
      (file) => file.absolutePath === manifestPath,
    ),
    archivedEvidenceHashes:
      archiveFiles.length > 0 &&
      archiveFiles.every((file) => sha256(readFileSync(file.absolutePath)) === file.sha256),
    archivedFixtureHashes:
      fixture.files.length > 0 &&
      fixture.files.every(
        (file) => sha256(readFileSync(resolveEvidencePath(fixtureRoot, file.path))) === file.sha256,
      ),
    archivedOfficialSourceHashes:
      official.sources.length > 0 &&
      official.sources.every(
        (file) =>
          sha256(readFileSync(resolveEvidencePath(officialRoot, file.path))) === file.sha256,
      ),
  };
  const passed = Object.values(gates).every(Boolean);
  const paths = [
    acceptancePath,
    identityMetadataPath,
    ...archiveFiles.map((file) => file.absolutePath),
  ];
  const result = {
    at: new Date().toISOString(),
    scope: 'historical archive audit',
    currentSourceValidation: 'not performed',
    historicalAcceptanceAt: acceptance.at,
    pathBase: 'repository',
    passed,
    gates,
    evidence: paths.map((path) => ({
      path: relativeEvidencePath(path),
      sha256: sha256(readFileSync(path)),
    })),
    limitations: [
      'Passing means archived evidence matches the retained historical acceptance and referenced file hashes.',
      'Historical tests, engineering results, identity and configuration claims are not rerun or validated against current source.',
      'No new RPC collection or permission to start P1. Current-source checks must be recorded separately with source hashes.',
    ],
  };
  writeFileSync('artifacts/p0/archive-audit.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(`P0 historical archive audit ${phase}: ${safeDiagnostic(error)}`);
  process.exitCode = 1;
}
