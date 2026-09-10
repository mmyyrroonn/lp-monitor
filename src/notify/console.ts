import type { AlertRecord } from '../signals/types.js';
import { formatAlert } from './format.js';

export type AlertSink = (alert: AlertRecord) => Promise<void> | void;

export function createConsoleSink(write: (text: string) => void = console.log): AlertSink {
  return (alert) => write(formatAlert(alert));
}
