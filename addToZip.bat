@echo off
del project-pi-team.zip
"c:\Program Files\7-Zip\7z.exe" a -tzip .\project-pi-team.zip -xr!.git -xr!.env* -xr!addToZip.bat -xr!node_modules