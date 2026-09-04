const path = require('path');
const { notarize } = require('@electron/notarize');

// One-time setup: xcrun notarytool store-credentials diffier-notary \
//   --apple-id <you@example.com> --team-id JB72T5K5AU --password <app-specific-password>
const NOTARY_PROFILE = 'diffier-notary';

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // ponytail: notarization is opt-in via NOTARIZE=1 so local/dev `yarn dist`
  // stays fast and doesn't need the keychain profile set up.
  if (!process.env.NOTARIZE) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  await notarize({ appPath, keychainProfile: NOTARY_PROFILE });
};
