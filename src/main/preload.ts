import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent, MotionBlurAPI } from '../shared/types';

const api: MotionBlurAPI = {
  getState: () => ipcRenderer.invoke('app:state'),
  pickClips: () => ipcRenderer.invoke('clips:pick'),
  inspectClips: paths => ipcRenderer.invoke('clips:inspect', paths),
  getPathForFile: file => webUtils.getPathForFile(file),
  updatePreferences: preferences => ipcRenderer.invoke('preferences:update', preferences),
  selectEngine: () => ipcRenderer.invoke('engine:select'),
  recheckEngine: () => ipcRenderer.invoke('engine:check'),
  pickOutputFolder: () => ipcRenderer.invoke('output:pick'),
  renderPreview: (clipId, start, settings) => ipcRenderer.invoke('jobs:preview', clipId, start, settings),
  startExport: (clipIds, settings, outputDirectory) => ipcRenderer.invoke('jobs:export', clipIds, settings, outputDirectory),
  cancelWork: () => ipcRenderer.invoke('jobs:cancel'),
  openOutput: path => ipcRenderer.invoke('output:open', path),
  openBlurDownload: () => ipcRenderer.invoke('engine:download'),
  copyText: text => ipcRenderer.invoke('clipboard:copy', text),
  onEvent: listener => {
    const receive = (_: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on('app:event', receive);
    return () => ipcRenderer.removeListener('app:event', receive);
  },
};
contextBridge.exposeInMainWorld('motionBlur', api);
