# Chrome Toolbar Minimiser

Hide Chrome’s tab strip, address bar and bookmarks bar to give the page more room. The Windows taskbar stays visible.

## Install on Windows

1. Open PowerShell in this folder and run the helper installer. It installs for your Windows account and needs no administrator access.

   ```powershell
   & '.\windows\Install-Helper.ps1'
   ```

2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**.
3. Select this folder, which contains `manifest.json`, then refresh any tabs you already had open.
4. To keep the button handy, open Chrome’s **Extensions** menu and pin **Chrome Toolbar Minimiser**.

## Use it

- **Toggle** with **Ctrl+Shift+Y** or click the extension button. **Green** means toolbar hiding is on. **Grey** means it’s off.
- **Reveal** by moving the pointer to the exposed top edge of Chrome. This also works while another app has focus.
- **Hide again** by moving away from the toolbar. It slides out of view after **2.5 seconds**. Return the pointer to the toolbar to cancel the countdown.
- **Watch fullscreen video** as usual. The extension pauses while the video is fullscreen and resumes when you exit.

Chrome remembers your on/off setting across new tabs and restarts. To change the hotkey, open `chrome://extensions/shortcuts`.

## Update or troubleshoot

- Before updating, turn toolbar hiding off. If the Windows helper has changed, run the installer again. Then click **Reload** on the extension card at `chrome://extensions` and refresh your tabs.
- If the icon shows **!**, hover over it for the error message. The helper keeps the bottom edge fixed in maximised and snapped windows and provides the smooth slide. The slide follows Windows’ **Animation effects** setting.
- Hover reveal needs a clear top screen edge. A Windows taskbar at the top or another monitor directly above Chrome can prevent it.
