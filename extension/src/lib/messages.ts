// Message contracts between content script, popup, and background worker.

import { type BridgeEventPayload, type EventType } from './types';

export type ExtensionMessage =
  | { type: 'CAPTURE_CURRENT_TAB' }
  | { type: 'TEST_CONNECTION'; connectionId: string }
  | {
      type: 'CONTENT_EVENT';
      eventType: EventType;
      sourceUrl: string;
      payload: BridgeEventPayload;
    }
  | { type: 'SHOW_TOAST'; toast: ToastData };

export interface ToastData {
  id: string;
  title: string;
  message: string;
  variant: 'success' | 'error' | 'info';
}
