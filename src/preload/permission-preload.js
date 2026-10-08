'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kitsunePermission', {
  onShow: (callback) => ipcRenderer.on('permission:show', (_event, data) => callback(data)),
  decide: (id, decision) => ipcRenderer.send('permission:decision', { id, decision })
});