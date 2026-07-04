'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const keymap = __importStar(require("./keymap"));
const themes = __importStar(require("./themes"));
async function call(channel, ...args) {
    const res = (await electron_1.ipcRenderer.invoke(channel, ...args));
    if (!res.ok)
        throw new Error(res.error);
    return res.value;
}
const api = {
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
    gitCommitFileDiff: (hash, relPath, type, origPath, ref2) => call('git:commitFileDiff', hash, relPath, type, origPath, ref2),
    gitImageData: (relPath, type, origPath, hash) => call('git:imageData', relPath, type, origPath, hash),
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
        electron_1.ipcRenderer.on('menu', (_e, id) => cb(id));
    },
    onRepoChanged: (cb) => {
        electron_1.ipcRenderer.on('repo:changed', () => cb());
    },
    onRepoOpened: (cb) => {
        electron_1.ipcRenderer.on('repo:opened', (_e, repo) => cb(repo));
    },
};
electron_1.contextBridge.exposeInMainWorld('api', api);
