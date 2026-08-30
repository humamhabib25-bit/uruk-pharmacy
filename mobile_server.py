import os
import sys
import socket
import subprocess
import threading
import time
import uvicorn
from main import app, DB_PATH, create_backup

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def print_banner(local_ip):
    print("=" * 65)
    print("      🏥 نظام صيدلية أوروك - خادم الموبايل والتزامن اللحظي 📱")
    print("=" * 65)
    print(f"📁 قاعدة البيانات النشطة: {DB_PATH}")
    print("⚡ التزامن: لحظي ومباشر (أي تعديل من الهاتف ينعكس فوراً)")
    print("-" * 65)
    print("🌐 روابط الدخول من الموبايل:")
    print(f"  1. داخل الصيدلية (نفس شبكة الواي فاي Wi-Fi):")
    print(f"     👉 http://{local_ip}:3000")
    print()
    print(f"  2. من نفس جهاز الكمبيوتر:")
    print(f"     👉 http://localhost:3000")
    print("-" * 65)
    print("💡 نصيحة: يمكنك فتح الرابط من متصفح هاتفك (Chrome أو Safari)")
    print("   ثم الضغط على (إضافة إلى الشاشة الرئيسية) ليعمل كتطبيق كامل!")
    print("=" * 65)
    print("🟢 السيرفر يعمل الآن... اضغط Ctrl+C للإغلاق في أي وقت.")
    print()

if __name__ == "__main__":
    local_ip = get_local_ip()
    print_banner(local_ip)
    uvicorn.run(app, host="0.0.0.0", port=3000, log_level="info")
