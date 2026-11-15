'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readFile:      (key)          => ipcRenderer.invoke('read-file', key),
  writeFile:     (key, content) => ipcRenderer.invoke('write-file', key, content),
  startSender:   ()             => ipcRenderer.invoke('start-sender'),
  stopSender:    ()             => ipcRenderer.invoke('stop-sender'),
  isRunning:     ()             => ipcRenderer.invoke('is-running'),
  readReport:    ()             => ipcRenderer.invoke('read-report'),
  openDashboard: ()             => ipcRenderer.invoke('open-dashboard'),
  onLog:         (cb)           => ipcRenderer.on('log', (_e, msg) => cb(msg)),
  onStopped:     (cb)           => ipcRenderer.on('sender-stopped', (_e, code) => cb(code)),
});
