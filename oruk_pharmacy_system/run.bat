@echo off
chcp 65001 >nul
echo جاري تشغيل سيرفر صيدلية أوروك...
start http://localhost:3000
node server.js
pause