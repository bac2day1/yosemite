@echo off
cd /d "%~dp0"
echo Starting Yosemite Valley Lodging Watcher...
echo Dashboard will be available at http://localhost:3847
start "" http://localhost:3847
npm start
