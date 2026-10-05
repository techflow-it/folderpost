Bundling a portable Node.js (Windows, no system-wide installation)
==================================================================

1. Open https://nodejs.org/en/download in a browser and choose
   "Windows Binary (.zip)" for 64-bit (LTS version, not the .msi installer).

   Direct link pattern (insert the current LTS version), e.g.:
   https://nodejs.org/dist/v22.x.x/node-v22.x.x-win-x64.zip

2. Extract the ZIP file.

3. Copy the entire contents of the extracted folder
   (node.exe, npm, node_modules, ... - not the folder itself) to:

     runtime\node-win-x64\

   Afterwards this file should exist:
     runtime\node-win-x64\node.exe

4. Start start.bat as usual by double-clicking it.
   It detects node.exe here and uses it - no separate Node.js setup required.

Note: node.exe and its files are about 100 MB and are therefore not part of
the repository.

---------------------------------------------------------------------------

Portables Node.js einbinden (Windows, ohne Systeminstallation)
==============================================================

1. https://nodejs.org/en/download öffnen und "Windows Binary (.zip)" für
   64-Bit wählen (LTS-Version, keine .msi-Installation).

2. Die ZIP-Datei entpacken.

3. Den gesamten Inhalt des entpackten Ordners (node.exe, npm, node_modules, …
   – nicht den Ordner selbst) nach runtime\node-win-x64\ kopieren.
   Danach existiert runtime\node-win-x64\node.exe.

4. start.bat wie gewohnt per Doppelklick starten – sie nutzt dann diese
   node.exe, ein separates Node-Setup ist nicht nötig.

Hinweis: node.exe und die zugehörigen Dateien sind ca. 100 MB groß und daher
nicht im Repository enthalten.
