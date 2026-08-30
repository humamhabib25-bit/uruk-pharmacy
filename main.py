from contextlib import asynccontextmanager
from datetime import datetime
import os
import shutil
import threading
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import sqlite3
import webview
import sys

# تحديد المسارات لتعمل بشكل صحيح وثابت في وضع الأوفلاين والـ .exe
if getattr(sys, 'frozen', False):
    # قاعدة البيانات تُحفظ في نفس المجلد الموجود فيه ملف الـ .exe لضمان عدم ضياع البيانات
    BASE_DIR = os.path.dirname(sys.executable)
    # ملفات الواجهة تُقرأ من المسار المؤقت للبرنامج
    PUBLIC_PATH = os.path.join(sys._MEIPASS, "public")
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    PUBLIC_PATH = os.path.join(BASE_DIR, "public")

DB_PATH = os.path.join(BASE_DIR, "uruk_pharmacy.db")

def create_backup():
    try:
        backup_dir = os.path.join(BASE_DIR, "backups")
        if not os.path.exists(backup_dir):
            os.makedirs(backup_dir)
        date_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        backup_path = os.path.join(backup_dir, f"uruk_pharmacy_backup_{date_str}.db")
        shutil.copyfile(DB_PATH, backup_path)
        print(f"✅ تم إنشاء نسخة احتياطية بنجاح: {backup_path}")
    except Exception as err:
        print("خطأ في النسخ الاحتياطي:", str(err))

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    print("\n🔄 جاري إغلاق النظام وعمل نسخة احتياطية للبيانات...")
    create_backup()

app = FastAPI(title="نظام إدارة مذاخر صيدلية أوروك", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if os.path.exists(PUBLIC_PATH):
    app.mount("/static", StaticFiles(directory=PUBLIC_PATH), name="static")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            phone TEXT DEFAULT '',
            category TEXT DEFAULT 'أدوية عامة',
            is_archived INTEGER DEFAULT 0
        )
    """)

    # فحص وإضافة الأعمدة الجديدة إذا كانت قاعدة البيانات سابقة
    cursor.execute("PRAGMA table_info(suppliers)")
    cols = [col["name"] for col in cursor.fetchall()]
    if "category" not in cols:
        cursor.execute("ALTER TABLE suppliers ADD COLUMN category TEXT DEFAULT 'أدوية عامة'")
    if "is_archived" not in cols:
        cursor.execute("ALTER TABLE suppliers ADD COLUMN is_archived INTEGER DEFAULT 0")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS supplier_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER,
            date TEXT,
            list_amount REAL DEFAULT 0,
            payment_amount REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            return_amount REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS payment_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_month TEXT,
            supplier_id INTEGER,
            planned_amount REAL DEFAULT 0,
            FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE,
            UNIQUE(plan_month, supplier_id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS daily_income (
            date TEXT PRIMARY KEY,
            amount REAL DEFAULT 0,
            cash_amount REAL DEFAULT 0,
            qicard_amount REAL DEFAULT 0,
            created_at TEXT DEFAULT ''
        )
    """)

    cursor.execute("PRAGMA table_info(daily_income)")
    income_cols = [col["name"] for col in cursor.fetchall()]
    if "cash_amount" not in income_cols:
        cursor.execute("ALTER TABLE daily_income ADD COLUMN cash_amount REAL DEFAULT 0")
    if "qicard_amount" not in income_cols:
        cursor.execute("ALTER TABLE daily_income ADD COLUMN qicard_amount REAL DEFAULT 0")
    
    # تحديث السجلات القديمة بحيث تكون قيم الكاش مساوية للإجمالي إن كانت أصفار
    cursor.execute("UPDATE daily_income SET cash_amount = amount WHERE cash_amount = 0 AND qicard_amount = 0 AND amount > 0")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_time TEXT,
            action_type TEXT,
            details TEXT
        )
    """)

    conn.commit()
    conn.close()

init_db()

@app.get("/")
@app.get("/index.html")
def read_root():
    # البحث عن index.html في المسارات المحتملة
    possible_paths = [
        os.path.join(PUBLIC_PATH, "index.html"),
        os.path.join(BASE_DIR, "public", "index.html"),
        os.path.join(BASE_DIR, "oruk_pharmacy_system", "public", "index.html"),
    ]
    for p in possible_paths:
        if os.path.exists(p):
            return FileResponse(p)
    return {"message": "🏥 نظام صيدلية أوروك يعمل بنجاح"}

@app.get("/{full_path:path}")
def catch_all(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="المسار غير موجود")
    # إذا كان ملف ثابت موجود في public
    static_file = os.path.join(PUBLIC_PATH, full_path)
    if os.path.exists(static_file) and os.path.isfile(static_file):
        return FileResponse(static_file)
    return read_root()

@app.get("/api/backup-download")
def download_backup():
    if os.path.exists(DB_PATH):
        return FileResponse(DB_PATH, filename=f"uruk_pharmacy_manual_backup_{datetime.now().strftime('%Y-%m-%d')}.db")
    raise HTTPException(status_code=404, detail="ملف قاعدة البيانات غير موجود")

@app.post("/api/backup-upload")
async def upload_backup(file: UploadFile = File(...)):
    if not file.filename.endswith('.db'):
        raise HTTPException(status_code=400, detail="يجب اختيار ملف قاعدة بيانات بصيغة .db")
    try:
        # أخذ نسخة أمان استباقية من قاعدة البيانات الحالية
        create_backup()
        contents = await file.read()
        with open(DB_PATH, "wb") as f:
            f.write(contents)
        
        # التأكد من الجداول وتحديث الهيكل إن لزم
        init_db()
        
        time_now = datetime.now().isoformat()
        conn = get_db()
        conn.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                     (time_now, 'استعادة نسخة احتياطية', f"تمت استعادة قاعدة البيانات من الملف: {file.filename}"))
        conn.commit()
        conn.close()
        return {"success": True, "message": "تمت استعادة النسخة الاحتياطية بنجاح"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"خطأ في استعادة النسخة الاحتياطية: {str(e)}")

class SupplierCreate(BaseModel):
    name: str
    phone: str = ""
    category: str = "أدوية عامة"

class SupplierUpdate(BaseModel):
    name: str
    phone: str = ""
    category: str = "أدوية عامة"

class TransactionCreate(BaseModel):
    supplier_id: int
    date: str = ""
    list_amount: float = 0
    payment_amount: float = 0
    discount_amount: float = 0
    return_amount: float = 0
    notes: str = ""

class PlanItem(BaseModel):
    supplier_id: int
    planned_amount: float

class PaymentPlanCreate(BaseModel):
    plan_month: str
    plans: list[PlanItem]

class IncomeCreate(BaseModel):
    date: str
    amount: float = 0
    cash_amount: float = 0
    qicard_amount: float = 0

@app.get("/api/suppliers")
def get_suppliers():
    conn = get_db()
    cursor = conn.cursor()
    query = """
        SELECT 
            s.id, s.name, s.phone, s.category, COALESCE(s.is_archived, 0) AS is_archived,
            COALESCE(SUM(t.list_amount), 0) AS total_lists,
            COALESCE(SUM(t.payment_amount), 0) AS total_payments,
            COALESCE(SUM(t.discount_amount), 0) AS total_discounts,
            COALESCE(SUM(t.return_amount), 0) AS total_returns,
            (COALESCE(SUM(t.list_amount), 0) - COALESCE(SUM(t.payment_amount), 0) - COALESCE(SUM(t.discount_amount), 0) - COALESCE(SUM(t.return_amount), 0)) AS remaining_balance
        FROM suppliers s
        LEFT JOIN supplier_transactions t ON s.id = t.supplier_id
        GROUP BY s.id
        ORDER BY s.name COLLATE NOCASE ASC
    """
    cursor.execute(query)
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

@app.post("/api/suppliers")
def create_supplier(supplier: SupplierCreate):
    name = supplier.name.strip()
    category = supplier.category.strip() or "أدوية عامة"
    if not name:
        raise HTTPException(status_code=400, detail="اسم المذخر مطلوب")
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO suppliers (name, phone, category, is_archived) VALUES (?, ?, ?, 0)", 
                       (name, supplier.phone.strip(), category))
        conn.commit()
        last_id = cursor.lastrowid
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)", 
                       (time_now, 'إضافة مذخر', f"إضافة مذخر جديد: {name} (تصنيف: {category})"))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="المذخر موجود مسبقاً")
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"id": last_id, "name": name, "phone": supplier.phone.strip(), "category": category, "is_archived": 0}

@app.put("/api/suppliers/{supplier_id}")
def update_supplier(supplier_id: int, supplier: SupplierUpdate):
    name = supplier.name.strip()
    category = supplier.category.strip() or "أدوية عامة"
    if not name:
        raise HTTPException(status_code=400, detail="اسم المذخر مطلوب")
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE suppliers SET name = ?, phone = ?, category = ? WHERE id = ?", 
                       (name, supplier.phone.strip(), category, supplier_id))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, 'تعديل مذخر', f"تعديل بيانات المذخر ID: {supplier_id} ({name})"))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="اسم المذخر مستخدم لمذخر آخر")
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

@app.put("/api/suppliers/{supplier_id}/archive")
def toggle_archive_supplier(supplier_id: int):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name, is_archived FROM suppliers WHERE id = ?", (supplier_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="المذخر غير موجود")
        
        new_status = 0 if row["is_archived"] == 1 else 1
        status_text = "أرشفة" if new_status == 1 else "إلغاء أرشفة"
        cursor.execute("UPDATE suppliers SET is_archived = ? WHERE id = ?", (new_status, supplier_id))
        
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, f'{status_text} مذخر', f"{status_text} المذخر: {row['name']}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True, "is_archived": new_status}

@app.delete("/api/suppliers/zero-balance")
def delete_zero_balance_suppliers():
    conn = get_db()
    cursor = conn.cursor()
    try:
        query = """
            SELECT s.id, s.name FROM suppliers s
            LEFT JOIN supplier_transactions t ON s.id = t.supplier_id
            GROUP BY s.id
            HAVING (COALESCE(SUM(t.list_amount), 0) - COALESCE(SUM(t.payment_amount), 0) - COALESCE(SUM(t.discount_amount), 0) - COALESCE(SUM(t.return_amount), 0)) = 0
        """
        cursor.execute(query)
        zero_suppliers = cursor.fetchall()
        
        for row in zero_suppliers:
            sup_id = row["id"]
            cursor.execute("DELETE FROM supplier_transactions WHERE supplier_id = ?", (sup_id,))
            cursor.execute("DELETE FROM payment_plans WHERE supplier_id = ?", (sup_id,))
            cursor.execute("DELETE FROM suppliers WHERE id = ?", (sup_id,))
            
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, 'مسح المذاخر الصفرية', f"تم مسح {len(zero_suppliers)} من المذاخر ذات الرصيد الصفري"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True, "deleted_count": len(zero_suppliers)}

@app.delete("/api/suppliers/{supplier_id}")
def delete_supplier(supplier_id: int):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name FROM suppliers WHERE id = ?", (supplier_id,))
        sup_row = cursor.fetchone()
        sup_name = sup_row["name"] if sup_row else f"ID {supplier_id}"

        cursor.execute("DELETE FROM supplier_transactions WHERE supplier_id = ?", (supplier_id,))
        cursor.execute("DELETE FROM payment_plans WHERE supplier_id = ?", (supplier_id,))
        cursor.execute("DELETE FROM suppliers WHERE id = ?", (supplier_id,))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, 'حذف مذخر', f"حذف المذخر: {sup_name}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

@app.get("/api/suppliers/{supplier_id}/statement")
def get_supplier_statement(supplier_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM supplier_transactions WHERE supplier_id = ? ORDER BY date ASC, id ASC", (supplier_id,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

@app.get("/api/all-transactions")
def get_all_transactions():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM supplier_transactions ORDER BY date ASC, id ASC")
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

@app.post("/api/supplier-transactions")
def create_transaction(tx: TransactionCreate):
    conn = get_db()
    cursor = conn.cursor()
    query = """
        INSERT INTO supplier_transactions 
        (supplier_id, date, list_amount, payment_amount, discount_amount, return_amount, notes) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    cursor.execute(query, (
        tx.supplier_id, 
        tx.date or '', 
        tx.list_amount or 0, 
        tx.payment_amount or 0, 
        tx.discount_amount or 0, 
        tx.return_amount or 0, 
        tx.notes or ''
    ))
    conn.commit()
    last_id = cursor.lastrowid
    time_now = datetime.now().isoformat()
    action_label = 'تسديد' if (tx.payment_amount or 0) > 0 else 'قائمة شراء'
    cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)", 
                   (time_now, f'حركة مالية ({action_label})', f"تسجيل {action_label} للمذخر ID: {tx.supplier_id} بمبلغ: {(tx.payment_amount or tx.list_amount):,.0f} د.ع"))
    conn.commit()
    conn.close()
    return {"success": True, "id": last_id}

@app.put("/api/supplier-transactions/{tx_id}")
def update_transaction(tx_id: int, tx: TransactionCreate):
    conn = get_db()
    cursor = conn.cursor()
    try:
        query = """
            UPDATE supplier_transactions 
            SET supplier_id = ?, date = ?, list_amount = ?, payment_amount = ?, discount_amount = ?, return_amount = ?, notes = ? 
            WHERE id = ?
        """
        cursor.execute(query, (
            tx.supplier_id, 
            tx.date or '', 
            tx.list_amount or 0, 
            tx.payment_amount or 0, 
            tx.discount_amount or 0, 
            tx.return_amount or 0, 
            tx.notes or '', 
            tx_id
        ))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)", 
                       (time_now, 'تعديل حركة', f"تعديل الحركة المالية ID: {tx_id}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

@app.delete("/api/supplier-transactions/{tx_id}")
def delete_transaction(tx_id: int):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM supplier_transactions WHERE id = ?", (tx_id,))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)", 
                       (time_now, 'حذف حركة', f"حذف الحركة المالية ID: {tx_id}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

# --- خطط التسديد ---
@app.get("/api/payment-plans/{month}")
def get_payment_plans(month: str):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM payment_plans WHERE plan_month = ?", (month,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

@app.post("/api/payment-plans")
def save_payment_plans(plan_data: PaymentPlanCreate):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM payment_plans WHERE plan_month = ?", (plan_data.plan_month,))
        for p in plan_data.plans:
            if p.planned_amount > 0:
                cursor.execute("INSERT INTO payment_plans (plan_month, supplier_id, planned_amount) VALUES (?, ?, ?)",
                               (plan_data.plan_month, p.supplier_id, p.planned_amount))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)", 
                       (time_now, 'خطة تسديد', f"تحديث خطة التسديد لشهر: {plan_data.plan_month}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

# --- سجل الإيرادات اليومية الدائم ---
@app.get("/api/income")
def get_daily_income():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT date, amount, COALESCE(cash_amount, amount) AS cash_amount, COALESCE(qicard_amount, 0) AS qicard_amount FROM daily_income ORDER BY date DESC")
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

@app.post("/api/income")
def save_daily_income(item: IncomeCreate):
    total = item.cash_amount + item.qicard_amount
    if total == 0 and item.amount > 0:
        total = item.amount
        cash = item.amount
        qicard = 0.0
    else:
        cash = item.cash_amount
        qicard = item.qicard_amount

    if not item.date or total < 0:
        raise HTTPException(status_code=400, detail="بيانات الدخل غير صالحة")
    conn = get_db()
    cursor = conn.cursor()
    try:
        time_now = datetime.now().isoformat()
        cursor.execute("""
            INSERT INTO daily_income (date, amount, cash_amount, qicard_amount, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET 
                amount = excluded.amount,
                cash_amount = excluded.cash_amount,
                qicard_amount = excluded.qicard_amount
        """, (item.date, total, cash, qicard, time_now))
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, 'تسجيل دخل', f"تسجيل دخل يوم {item.date} بإجمالي: {total:,.0f} د.ع (كاش: {cash:,.0f} | كي كارد: {qicard:,.0f})"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True, "date": item.date, "amount": total, "cash_amount": cash, "qicard_amount": qicard}

@app.delete("/api/income/{date}")
def delete_daily_income(date: str):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM daily_income WHERE date = ?", (date,))
        time_now = datetime.now().isoformat()
        cursor.execute("INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)",
                       (time_now, 'حذف دخل', f"حذف دخل يوم: {date}"))
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    conn.close()
    return {"success": True}

@app.get("/api/audit-logs")
def get_audit_logs():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200")
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows

def run_server():
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_config=None)

if __name__ == "__main__":
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    webview.create_window(
        title="صيدلية أوروك - نظام الإدارة",
        url="http://127.0.0.1:3000",
        width=1280,
        height=768,
        min_size=(1024, 600)
    )
    webview.start(private_mode=False)