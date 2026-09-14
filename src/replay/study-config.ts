import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ConfigError } from '../config/env.js';

export interface StudyPeriod {
  startSec: number;
  endSec: number;
}

export interface StudyPeriods {
  train: StudyPeriod;
  validation: StudyPeriod;
  test: StudyPeriod;
}

/** Declared before training so the validation decision cannot be chosen after
 * seeing the outcome windows. The sample threshold says a window is evaluable;
 * the forward-effect criteria say the candidate standard is actually met. */
export interface StudyValidationRequirement {
  primaryHorizonMinutes: 15 | 60 | 180;
  minimumCompleteOutcomeWindows: number;
  minimumForwardSwapCount: number;
  minimumForwardUsdMicros: string;
  minimumRelativeMultiple: number | null;
}

export const DEFAULT_STUDY_VALIDATION: StudyValidationRequirement = {
  primaryHorizonMinutes: 60,
  minimumCompleteOutcomeWindows: 1,
  minimumForwardSwapCount: 1,
  minimumForwardUsdMicros: '0',
  minimumRelativeMultiple: null,
};

export interface StudyConfig {
  version: 1;
  chainId: 4663;
  datasetManifest: string;
  periods: StudyPeriods;
  cohortMode: 'as-of' | 'retrospective-cohort';
  ruleVersion: string;
  grid: string;
  mode: 'chain-time' | 'recorded-observed';
  cadenceSec: number;
  warmupMinutes: number;
  outcomeMinutes: number;
  validation: StudyValidationRequirement;
}

function validationRequirement(value: unknown): StudyValidationRequirement {
  if (value === undefined) return DEFAULT_STUDY_VALIDATION;
  if (!value || typeof value !== 'object')
    throw new ConfigError('Study validation requirement must be an object');
  const item = value as Record<string, unknown>;
  const primary = item.primaryHorizonMinutes;
  const minimum = item.minimumCompleteOutcomeWindows;
  const swapCount =
    item.minimumForwardSwapCount ?? DEFAULT_STUDY_VALIDATION.minimumForwardSwapCount;
  const usdMicros =
    item.minimumForwardUsdMicros ?? DEFAULT_STUDY_VALIDATION.minimumForwardUsdMicros;
  const multiple = item.minimumRelativeMultiple ?? DEFAULT_STUDY_VALIDATION.minimumRelativeMultiple;
  if (![15, 60, 180].includes(primary as number))
    throw new ConfigError('Study validation primaryHorizonMinutes is invalid');
  if (!Number.isSafeInteger(minimum) || (minimum as number) < 1)
    throw new ConfigError(
      'Study validation minimumCompleteOutcomeWindows must be a positive integer',
    );
  if (!Number.isSafeInteger(swapCount) || (swapCount as number) < 0)
    throw new ConfigError(
      'Study validation minimumForwardSwapCount must be a non-negative integer',
    );
  if (typeof usdMicros !== 'string' || !/^\d+$/.test(usdMicros))
    throw new ConfigError('Study validation minimumForwardUsdMicros must be a decimal string');
  if (
    multiple !== null &&
    (typeof multiple !== 'number' || !Number.isFinite(multiple) || multiple <= 0)
  )
    throw new ConfigError('Study validation minimumRelativeMultiple must be null or positive');
  return {
    primaryHorizonMinutes: primary as 15 | 60 | 180,
    minimumCompleteOutcomeWindows: minimum as number,
    minimumForwardSwapCount: swapCount as number,
    minimumForwardUsdMicros: usdMicros,
    minimumRelativeMultiple: multiple as number | null,
  };
}

function period(value: unknown, field: string): StudyPeriod {
  if (!value || typeof value !== 'object') throw new ConfigError(`Invalid study period: ${field}`);
  const item = value as Record<string, unknown>;
  const startSec = item.startSec;
  const endSec = item.endSec;
  if (
    !Number.isSafeInteger(startSec) ||
    !Number.isSafeInteger(endSec) ||
    (startSec as number) < 0 ||
    (endSec as number) <= (startSec as number)
  )
    throw new ConfigError(`Invalid study period: ${field}`);
  return { startSec: startSec as number, endSec: endSec as number };
}

export function validateStudyPeriods(periods: StudyPeriods): void {
  const train = period(periods?.train, 'train');
  const validation = period(periods?.validation, 'validation');
  const test = period(periods?.test, 'test');
  if (train.endSec > validation.startSec || validation.endSec > test.startSec)
    throw new ConfigError('Study periods must be ordered and non-overlapping');
}

export function studySplitAt(
  sec: number,
  periods: StudyPeriods,
): 'train' | 'validation' | 'test' | 'outside' {
  if (!Number.isSafeInteger(sec)) throw new RangeError('Study split time must be a safe integer');
  validateStudyPeriods(periods);
  if (sec >= periods.train.startSec && sec < periods.train.endSec) return 'train';
  if (sec >= periods.validation.startSec && sec < periods.validation.endSec) return 'validation';
  if (sec >= periods.test.startSec && sec < periods.test.endSec) return 'test';
  return 'outside';
}

export function parseStudyConfig(path: string): StudyConfig {
  const configPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new ConfigError('Unreadable study config');
  }
  if (!parsed || typeof parsed !== 'object') throw new ConfigError('Invalid study config');
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || value.chainId !== 4663)
    throw new ConfigError('Study config must target chain 4663, version 1');
  validateStudyPeriods(value.periods as StudyPeriods);
  if (!['as-of', 'retrospective-cohort'].includes(String(value.cohortMode)))
    throw new ConfigError('Study config cohortMode is invalid');
  if (!['chain-time', 'recorded-observed'].includes(String(value.mode)))
    throw new ConfigError('Study config mode is invalid');
  if (
    typeof value.ruleVersion !== 'string' ||
    !value.ruleVersion.trim() ||
    typeof value.grid !== 'string' ||
    !value.grid.trim() ||
    typeof value.datasetManifest !== 'string' ||
    !value.datasetManifest.trim()
  )
    throw new ConfigError('Study config requires datasetManifest, ruleVersion and grid');
  for (const [key, min] of [
    ['cadenceSec', 1],
    ['warmupMinutes', 0],
    ['outcomeMinutes', 0],
  ] as const) {
    const number = value[key];
    if (!Number.isSafeInteger(number) || (number as number) < min)
      throw new ConfigError(`Study config ${key} is invalid`);
  }
  return {
    version: 1,
    chainId: 4663,
    datasetManifest: resolve(dirname(configPath), value.datasetManifest as string),
    periods: value.periods as StudyPeriods,
    cohortMode: value.cohortMode as StudyConfig['cohortMode'],
    ruleVersion: value.ruleVersion as string,
    grid: resolve(dirname(configPath), value.grid as string),
    mode: value.mode as StudyConfig['mode'],
    cadenceSec: value.cadenceSec as number,
    warmupMinutes: value.warmupMinutes as number,
    outcomeMinutes: value.outcomeMinutes as number,
    validation: validationRequirement(value.validation),
  };
}
