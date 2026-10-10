const fs = require('fs');
const path = require('path');

// Electron's zip carries its own LICENSE and Chromium's LICENSES.chromium.html
// beside the .app, and on macOS electron-builder deletes both (electronMac.js,
// createMacApp). Their notices must ship with the binary, so move them into
// the bundle's Resources first; this hook runs between the unzip and that delete.
module.exports = async function afterExtract(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = fs.readdirSync(context.appOutDir).find((f) => f.endsWith('.app'));
  const resources = path.join(context.appOutDir, app, 'Contents', 'Resources');
  for (const [from, to] of [
    ['LICENSE', 'LICENSE.electron.txt'],
    ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
  ]) {
    fs.renameSync(path.join(context.appOutDir, from), path.join(resources, to));
  }
};
