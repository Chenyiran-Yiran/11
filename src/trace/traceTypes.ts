/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type ContextCreatedTraceEvent = {
  timestamp: number,
  type: 'context-created',
  browserName: string,
  contextId: string,
  deviceScaleFactor: number,
  isMobile: boolean,
  viewportSize?: { width: number, height: number },
};

export type ContextDestroyedTraceEvent = {
  timestamp: number,
  type: 'context-destroyed',
  contextId: string,
};

export type NetworkResourceTraceEvent = {
  timestamp: number,
  type: 'resource',
  contextId: string,
  pageId: string,
  frameId: string,
  resourceId: string,
  url: string,
  contentType: string,
  responseHeaders: { name: string, value: string }[],
  requestHeaders: { name: string, value: string }[],
  method: string,
  status: number,
  requestSha1: string,
  responseSha1: string,
};

export type PageCreatedTraceEvent = {
  timestamp: number,
  type: 'page-created',
  contextId: string,
  pageId: string,
};

export type PageDestroyedTraceEvent = {
  timestamp: number,
  type: 'page-destroyed',
  contextId: string,
  pageId: string,
};

export type PageVideoTraceEvent = {
  timestamp: number,
  type: 'page-video',
  contextId: string,
  pageId: string,
  fileName: string,
};

export type ActionTraceEvent = {
  timestamp: number,
  type: 'action',
  contextId: string,
  action: string,
  pageId?: string,
  selector?: string,
  label?: string,
  value?: string,
  startTime: number,
  endTime: number,
  logs?: string[],
  stack?: string,
  error?: string,
  snapshots?: { name: string, snapshotId: string }[],
};

export type DialogOpenedEvent = {
  timestamp: number,
  type: 'dialog-opened',
  contextId: string,
  pageId: string,
  dialogType: string,
  message?: string,
};

export type DialogClosedEvent = {
  timestamp: number,
  type: 'dialog-closed',
  contextId: string,
  pageId: string,
  dialogType: string,
};

export type NavigationEvent = {
  timestamp: number,
  type: 'navigation',
  contextId: string,
  pageId: string,
  url: string,
  sameDocument: boolean,
};

export type LoadEvent = {
  timestamp: number,
  type: 'load',
  contextId: string,
  pageId: string,
};

export type FrameSnapshotTraceEvent = {
  timestamp: number,
  type: 'snapshot',
  contextId: string,
  pageId: string,
  frameId: string,  // Empty means main frame.
  snapshot: FrameSnapshot,
  frameUrl: string,
  snapshotId?: string,
};

export type TraceEvent =
    ContextCreatedTraceEvent |
    ContextDestroyedTraceEvent |
    PageCreatedTraceEvent |
    PageDestroyedTraceEvent |
    PageVideoTraceEvent |
    NetworkResourceTraceEvent |
    ActionTraceEvent |
    DialogOpenedEvent |
    DialogClosedEvent |
    NavigationEvent |
    LoadEvent |
    FrameSnapshotTraceEvent;


export type FrameSnapshot = {
  html: string,
  resourceOverrides: { url: string, sha1: string }[],
  viewport: { width: number, height: number },
};
