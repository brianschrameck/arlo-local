# Camera Sample Provider Plugin for Scrypted

This is a sample plugin that shows how to add camera providers like Unifi, Ring, Nest, etc.

The plugin will "discover" all the cameras, and report them to Scrypted.

The "discovered" cameras will have dummy snapshots and video.


1. npm install
2. Open this plugin director yin VS Code.
3. Edit `.vscode/settings.json` to point to the IP address of your Scrypted server. The default is `127.0.0.1`, your local machine.
4. Press Launch (green arrow button in the Run and Debug sidebar) to start debugging.
  * The VS Code `Terminal` area may show an authentication failure and prompt you to log in to the Scrypted Management Console with `npx scrypted login`. You will only need to do this once. You can then relaunch afterwards.
