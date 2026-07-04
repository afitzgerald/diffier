'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const keymap = require('./keymap');
const themes = require('./themes');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

contextBridge.exposeInMainWorld('api', {
  openRepoDialog: () => call('repo:openDialog'),
  openRepo: (dir) => call('repo:open', dir),
  openLastRepo: () => call('repo:last'),

  gitStatus: () => call('git:status'),
  gitDiff: (relPath, type, origPath) => call('git:diff', relPath, type, origPath),
  gitCommit: (opts) => call('git:commit', opts),
  gitPush: () => call('git:push'),
  gitRollback: (files) => call('git:rollback', files),
  gitLastMessage: () => call('git:lastMessage'),

  saveFile: (relPath, content) => call('file:save', relPath, content),
  revealFile: (relPath) => call('shell:reveal', relPath),
  confirm: (opts) => call('app:confirm', opts),

  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),

  keymapActions: keymap.ACTIONS,
  setKeymap: (overrides) => call('keymap:set', overrides),

  themes: themes.THEMES,
  defaultTheme: themes.DEFAULT_THEME,

  onMenu: (cb) => ipcRenderer.on('menu', (_e, id) => cb(id)),
  onRepoChanged: (cb) => ipcRenderer.on('repo:changed', () => cb()),
});
