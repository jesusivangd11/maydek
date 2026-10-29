/**
 * Puente mínimo entre el asistente de primer uso (y la pantalla de carga) y el
 * proceso principal. La página no tiene acceso a Node: solo a estas funciones.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  submit: (data) => ipcRenderer.invoke('setup:submit', data),
  onProgress: (callback) => ipcRenderer.on('progress', (_event, text) => callback(text)),
});
