@echo off
chcp 65001 >nul
title صيدلية أوروك - رفع التحديثات إلى GitHub
color 0B
cls
echo ====================================================================
echo        🐙 صيدلية أوروك - رفع التحديثات إلى GitHub 🚀
echo ====================================================================
echo.
echo المستودع المرتبط: https://github.com/humamhabib25-bit/uruk-pharmacy.git
echo.
echo 1. جاري تجهيز الملفات وتثبيت التعديلات...
git add .
git commit -m "Update Uruk Pharmacy System"
echo.
echo 2. جاري الرفع إلى GitHub...
git branch -M main
git push -u origin main
echo.
echo ====================================================================
echo ✅ تم الرفع والتزامن مع GitHub بنجاح!
echo ====================================================================
pause
