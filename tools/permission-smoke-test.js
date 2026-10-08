'use strict';

// Реальные запросы Chromium с тестовыми устройствами и отдельным профилем.
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-permissions-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Permission test</title>');
});
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
require('../src/main/main.js');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => { console.error('Permission smoke timeout'); app.exit(1); }, 60000);

async function request(wc, code, decision) {
  const result = wc.executeJavaScript(code, true);
  let prompt;
  for (let i = 0; i < 100; i++) {
    prompt = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/permission.html'));
    if (prompt && !prompt.webContents.isLoading()) break;
    await wait(100);
  }
  if (!prompt) throw new Error('Окно разрешения не появилось');
  await wait(150);
  if (decision === 'close') prompt.destroy();
  else await prompt.webContents.executeJavaScript(`document.querySelector('[data-decision="${decision}"]').click()`);
  const value = await result;
  if (!prompt.isDestroyed()) throw new Error('Окно разрешения не закрылось');
  return value;
}

app.whenReady().then(async () => {
  try {
    await ready;
    await wait(2500);
    const win = BrowserWindow.getAllWindows()[0];
    const url = `http://127.0.0.1:${server.address().port}`;
    await win.webContents.executeJavaScript(`window.kitsune.tabs.create({url:${JSON.stringify(url)}})`);
    await wait(1200);
    const state = await win.webContents.executeJavaScript('window.kitsune.getState()');
    const wc = webContents.fromId(state.active.wcId);
    for (const constraints of [{ audio: true }, { video: true }]) {
      const code = `navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'allowed'}, e=>e.name)`;
      const value = await request(wc, code, 'once');
      if (value !== 'allowed') throw new Error(`getUserMedia: ${value}`);
      console.log('[OK] getUserMedia', JSON.stringify(constraints));
    }
    const geo = await request(wc, `new Promise(r=>navigator.geolocation.getCurrentPosition(()=>r(0),e=>r(e.code)))`, 'close');
    if (geo !== 1) throw new Error(`geolocation: ${geo}`);
    console.log('[OK] Геолокация отклонена при уничтожении окна');
    const display = await request(wc, `navigator.mediaDevices.getDisplayMedia({video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'allowed'},e=>e.name)`, 'deny');
    if (!['NotAllowedError', 'AbortError'].includes(display)) throw new Error(`getDisplayMedia: ${display}`);
    console.log('[OK] getDisplayMedia вызывает окно и корректно отклоняется');
    const { dialog } = require('electron');
    const original = dialog.showMessageBox;
    let pickerShown = false;
    dialog.showMessageBox = async (options) => {
      pickerShown = options.buttons.length > 1 && options.buttons[0] === 'Отмена';
      return { response: 1 };
    };
    const capture = await request(wc, `navigator.mediaDevices.getDisplayMedia({video:true}).then(s=>{const n=s.getVideoTracks().length;s.getTracks().forEach(t=>t.stop());return n},e=>e.name)`, 'once');
    dialog.showMessageBox = original;
    if (capture !== 1 || !pickerShown) throw new Error(`Screen capture: ${capture}, picker: ${pickerShown}`);
    console.log('[OK] Выбор источника и настоящий видеопоток getDisplayMedia');
    server.close();
    app.exit(0);
  } catch (err) {
    console.error(err);
    server.close();
    app.exit(1);
  }
});