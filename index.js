const { app, BrowserWindow } = require('electron');
require('electron-context-menu')({
  showInspectElement: true
});
require('electron-debug')({
  showDevTools: false
});

function createWindow () {
  // Create the browser window.
  let win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/index.html`);
}

app.on('ready', createWindow);