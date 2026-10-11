@echo off
del project.zip
"c:\Program Files\7-Zip\7z.exe" a -tzip .\project.zip -xr!.git -xr!.env* -xr!addToZip.bat -xr!node_modules