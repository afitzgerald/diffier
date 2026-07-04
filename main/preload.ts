'use strict';

import { contextBridge, ipcRenderer } from 'electron';
import * as keymap from './keymap';
import * as themes from './themes';
import type { DiffierApi } from './api-types';

interface IpcResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!res.ok) throw new Error(res.error);
  return res.value as T;
}

const api: DiffierApi = {
  openRepoDialog: () => call('repo:openDialog'),
  openRepo: (dir) => call('repo:open', dir),
  openLastRepo: () => call('repo:last'),

  gitStatus: () => call('git:status'),
  gitDiff: (relPath, type, origPath) => call('git:diff', relPath, type, origPath),
  gitCommit: (opts) => call('git:commit', opts),
  gitPush: () => call('git:push'),
  gitPull: () => call('git:pull'),
  gitFetch: () => call('git:fetch'),
  gitBranches: () => call('git:branches'),
  gitCheckout: (name) => call('git:checkout', name),
  gitCreateBranch: (name) => call('git:createBranch', name),
  gitLog: (opts) => call('git:log', opts),
  gitCommitDetails: (hash) => call('git:commitDetails', hash),
  gitCommitFileDiff: (hash, relPath, type, origPath, ref2) =>
    call('git:commitFileDiff', hash, relPath, type, origPath, ref2),
  gitImageData: (relPath, type, origPath, hash) =>
    call('git:imageData', relPath, type, origPath, hash),
  gitStashList: () => call('git:stashList'),
  gitStashPush: (message, includeUntracked) => call('git:stashPush', message, includeUntracked),
  gitStashPop: (ref) => call('git:stashPop', ref),
  gitStashApply: (ref) => call('git:stashApply', ref),
  gitStashDrop: (ref) => call('git:stashDrop', ref),
  gitBlame: (relPath) => call('git:blame', relPath),
  gitConflictInfo: (relPath) => call('git:conflictInfo', relPath),
  gitMarkResolved: (relPath, content) => call('git:markResolved', relPath, content),
  gitCommitTemplate: () => call('git:commitTemplate'),
  gitRollback: (files) => call('git:rollback', files),
  gitLastMessage: () => call('git:lastMessage'),
  setBadge: (count) => call('app:badge', count),
  getAppInfo: () => call('app:info'),

  saveFile: (relPath, content) => call('file:save', relPath, content),
  revealFile: (relPath) => call('shell:reveal', relPath),
  confirm: (opts) => call('app:confirm', opts),

  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),

  keymapActions: keymap.ACTIONS,
  setKeymap: (overrides) => call('keymap:set', overrides),

  themes: themes.THEMES,
  defaultTheme: themes.DEFAULT_THEME,

  onMenu: (cb) => {
    ipcRenderer.on('menu', (_e, id) => cb(id));
  },
  onRepoChanged: (cb) => {
    ipcRenderer.on('repo:changed', () => cb());
  },
  onRepoOpened: (cb) => {
    ipcRenderer.on('repo:opened', (_e, repo) => cb(repo));
  },
};

contextBridge.exposeInMainWorld('api', api);
