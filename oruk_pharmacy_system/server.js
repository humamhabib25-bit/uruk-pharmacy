const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إنشاء واتصال قاعدة بيانات SQLite
const dbFile = path.join(__dirname, 'oruk_pharmacy.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('تم الاتصال بقاعدة بيانات SQLite بنجاح.');
        initDatabase();
    }
});

// تهيئة الجداول وتفعيل قيود المفاتيح الخارجية
function initDatabase() {
    db.run("PRAGMA foreign_keys = ON");
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            phone TEXT DEFAULT '',
            category TEXT DEFAULT 'أدوية عامة',
            is_archived INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS supplier_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER,
            date TEXT,
            list_amount REAL DEFAULT 0,
            payment_amount REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            return_amount REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS payment_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_month TEXT,
            supplier_id INTEGER,
            planned_amount REAL DEFAULT 0,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
            UNIQUE(plan_month, supplier_id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS daily_income (
            date TEXT PRIMARY KEY,
            amount REAL DEFAULT 0,
            cash_amount REAL DEFAULT 0,
            qicard_amount REAL DEFAULT 0,
            created_at TEXT DEFAULT ''
        )`);

        db.all("PRAGMA table_info(daily_income)", [], (err, cols) => {
            if (!err && cols) {
                const colNames = cols.map(c => c.name);
                if (!colNames.includes('cash_amount')) db.run("ALTER TABLE daily_income ADD COLUMN cash_amount REAL DEFAULT 0");
                if (!colNames.includes('qicard_amount')) db.run("ALTER TABLE daily_income ADD COLUMN qicard_amount REAL DEFAULT 0");
                db.run("UPDATE daily_income SET cash_amount = amount WHERE cash_amount = 0 AND qicard_amount = 0 AND amount > 0");
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_time TEXT,
            action_type TEXT,
            details TEXT
        )`);
    });
}

function logAudit(actionType, details) {
    const timeNow = new Date().toISOString();
    db.run(`INSERT INTO audit_logs (action_time, action_type, details) VALUES (?, ?, ?)`, [timeNow, actionType, details]);
}

// --- API المذاخر والحركات ---

// جلب جميع المذاخر مع حساب الأرصدة الإجمالية
app.get('/api/suppliers', (req, res) => {
    const query = `
        SELECT s.id, s.name, s.phone, s.category, COALESCE(s.is_archived, 0) AS is_archived,
        COALESCE(SUM(t.list_amount), 0) as total_lists,
        COALESCE(SUM(t.payment_amount), 0) as total_payments,
        COALESCE(SUM(t.discount_amount), 0) as total_discounts,
        COALESCE(SUM(t.return_amount), 0) as total_returns,
        (COALESCE(SUM(t.list_amount), 0) - (COALESCE(SUM(t.payment_amount), 0) + COALESCE(SUM(t.discount_amount), 0) + COALESCE(SUM(t.return_amount), 0))) as remaining_balance
        FROM suppliers s
        LEFT JOIN supplier_transactions t ON s.id = t.supplier_id
        GROUP BY s.id
        ORDER BY s.name COLLATE NOCASE ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// إضافة مذخر جديد
app.post('/api/suppliers', (req, res) => {
    const { name, phone, category } = req.body;
    const cleanName = (name || '').trim();
    const cleanCat = (category || 'أدوية عامة').trim();
    if (!cleanName) return res.status(400).json({ error: 'اسم المذخر مطلوب' });
    db.run(`INSERT INTO suppliers (name, phone, category, is_archived) VALUES (?, ?, ?, 0)`, [cleanName, (phone || '').trim(), cleanCat], function(err) {
        if (err) return res.status(400).json({ error: 'المذخر موجود مسبقاً' });
        logAudit('إضافة مذخر', `تم إضافة مذخر جديد: ${cleanName} (تصنيف: ${cleanCat})`);
        res.json({ id: this.lastID, name: cleanName, phone: phone || '', category: cleanCat, is_archived: 0 });
    });
});

// تعديل بيانات مذخر
app.put('/api/suppliers/:id', (req, res) => {
    const supId = req.params.id;
    const { name, phone, category } = req.body;
    const cleanName = (name || '').trim();
    const cleanCat = (category || 'أدوية عامة').trim();
    if (!cleanName) return res.status(400).json({ error: 'اسم المذخر مطلوب' });
    db.run(`UPDATE suppliers SET name = ?, phone = ?, category = ? WHERE id = ?`, [cleanName, (phone || '').trim(), cleanCat, supId], function(err) {
        if (err) return res.status(400).json({ error: 'خطأ في تحديث المذخر أو الاسم مستخدم' });
        logAudit('تعديل مذخر', `تعديل بيانات المذخر ID: ${supId} (${cleanName})`);
        res.json({ success: true });
    });
});

// أرشفة / إلغاء أرشفة مذخر
app.put('/api/suppliers/:id/archive', (req, res) => {
    const supId = req.params.id;
    db.get(`SELECT name, is_archived FROM suppliers WHERE id = ?`, [supId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'المذخر غير موجود' });
        const newStatus = row.is_archived === 1 ? 0 : 1;
        const statusText = newStatus === 1 ? 'أرشفة' : 'إلغاء أرشفة';
        db.run(`UPDATE suppliers SET is_archived = ? WHERE id = ?`, [newStatus, supId], function(updateErr) {
            if (updateErr) return res.status(500).json({ error: updateErr.message });
            logAudit(`${statusText} مذخر`, `${statusText} المذخر: ${row.name}`);
            res.json({ success: true, is_archived: newStatus });
        });
    });
});

// مسح المذاخر الصفرية
app.delete('/api/suppliers/zero-balance', (req, res) => {
    const query = `
        SELECT s.id, s.name FROM suppliers s
        LEFT JOIN supplier_transactions t ON s.id = t.supplier_id
        GROUP BY s.id
        HAVING (COALESCE(SUM(t.list_amount), 0) - (COALESCE(SUM(t.payment_amount), 0) + COALESCE(SUM(t.discount_amount), 0) + COALESCE(SUM(t.return_amount), 0))) = 0
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows || rows.length === 0) return res.json({ success: true, deleted_count: 0 });

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const deleteIds = rows.map(r => r.id);
            const placeholders = deleteIds.map(() => '?').join(',');

            db.run(`DELETE FROM supplier_transactions WHERE supplier_id IN (${placeholders})`, deleteIds);
            db.run(`DELETE FROM payment_plans WHERE supplier_id IN (${placeholders})`, deleteIds);
            db.run(`DELETE FROM suppliers WHERE id IN (${placeholders})`, deleteIds, (delErr) => {
                if (delErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: delErr.message });
                }
                db.run('COMMIT', () => {
                    logAudit('مسح المذاخر الصفرية', `تم مسح ${rows.length} من المذاخر الصفرية`);
                    res.json({ success: true, deleted_count: rows.length });
                });
            });
        });
    });
});

// حذف مذخر نهائياً مع كافة حركاته وخططه المرتبطة بشكل آمن
app.delete('/api/suppliers/:id', (req, res) => {
    const supId = req.params.id;
    
    db.get(`SELECT name FROM suppliers WHERE id = ?`, [supId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'المذخر غير موجود' });
        }
        const supName = row.name;

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`DELETE FROM supplier_transactions WHERE supplier_id = ?`, [supId], (err1) => {
                if (err1) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ error: err1.message });
                }

                db.run(`DELETE FROM payment_plans WHERE supplier_id = ?`, [supId], (err2) => {
                    if (err2) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ error: err2.message });
                    }

                    db.run(`DELETE FROM suppliers WHERE id = ?`, [supId], function(err3) {
                        if (err3) {
                            db.run(`ROLLBACK`);
                            return res.status(500).json({ error: err3.message });
                        }

                        db.run(`COMMIT`, (commitErr) => {
                            if (commitErr) {
                                return res.status(500).json({ error: commitErr.message });
                            }
                            logAudit('حذف مذخر', `تم حذف المذخر: ${supName}`);
                            res.json({ success: true });
                        });
                    });
                });
            });
        });
    });
});

// جلب كشف حساب مذخر معني
app.get('/api/suppliers/:id/statement', (req, res) => {
    const supId = req.params.id;
    db.all(`SELECT * FROM supplier_transactions WHERE supplier_id = ? ORDER BY date ASC, id ASC`, [supId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// جلب كافة الحركات دفعة واحدة لتسريع الأداء
app.get('/api/all-transactions', (req, res) => {
    db.all(`SELECT * FROM supplier_transactions ORDER BY date ASC, id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// إضافة حركة مالية
app.post('/api/supplier-transactions', (req, res) => {
    const { supplier_id, date, list_amount, payment_amount, discount_amount, return_amount, notes } = req.body;
    const query = `INSERT INTO supplier_transactions (supplier_id, date, list_amount, payment_amount, discount_amount, return_amount, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [supplier_id, date || '', list_amount || 0, payment_amount || 0, discount_amount || 0, return_amount || 0, notes || ''], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const actionLabel = (payment_amount || 0) > 0 ? 'تسديد' : 'قائمة شراء';
        logAudit(`حركة مالية (${actionLabel})`, `إضافة ${actionLabel} لمذخر ID: ${supplier_id}`);
        res.json({ id: this.lastID, success: true });
    });
});

// تعديل حركة مالية
app.put('/api/supplier-transactions/:id', (req, res) => {
    const transId = req.params.id;
    const { date, list_amount, payment_amount, discount_amount, return_amount, notes } = req.body;
    const query = `UPDATE supplier_transactions SET date = ?, list_amount = ?, payment_amount = ?, discount_amount = ?, return_amount = ?, notes = ? WHERE id = ?`;
    db.run(query, [date || '', list_amount || 0, payment_amount || 0, discount_amount || 0, return_amount || 0, notes || '', transId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('تعديل حركة', `تم تعديل الحركة المالية ID: ${transId}`);
        res.json({ success: true });
    });
});

// حذف حركة مالية
app.delete('/api/supplier-transactions/:id', (req, res) => {
    const transId = req.params.id;
    db.run(`DELETE FROM supplier_transactions WHERE id = ?`, [transId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('حذف حركة', `تم حذف الحركة المالية ID: ${transId}`);
        res.json({ success: true });
    });
});

// --- خطط التسديد ---
app.get('/api/payment-plans/:month', (req, res) => {
    const month = req.params.month;
    db.all(`SELECT * FROM payment_plans WHERE plan_month = ?`, [month], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/payment-plans', (req, res) => {
    const { plan_month, plans } = req.body;
    db.run(`DELETE FROM payment_plans WHERE plan_month = ?`, [plan_month], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        const stmt = db.prepare(`INSERT INTO payment_plans (plan_month, supplier_id, planned_amount) VALUES (?, ?, ?)`);
        plans.forEach(p => {
            if (p.planned_amount > 0) {
                stmt.run(plan_month, p.supplier_id, p.planned_amount);
            }
        });
        stmt.finalize();
        logAudit('خطة تسديد', `تم تحديث خطة التسديد لشهر: ${plan_month}`);
        res.json({ success: true });
    });
});

// --- سجل الإيرادات اليومية ---
app.get('/api/income', (req, res) => {
    db.all(`SELECT date, amount, COALESCE(cash_amount, amount) AS cash_amount, COALESCE(qicard_amount, 0) AS qicard_amount FROM daily_income ORDER BY date DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/income', (req, res) => {
    const { date, amount, cash_amount, qicard_amount } = req.body;
    const cash = parseFloat(cash_amount || 0);
    const qicard = parseFloat(qicard_amount || 0);
    let total = cash + qicard;
    if (total === 0 && parseFloat(amount || 0) > 0) {
        total = parseFloat(amount);
    }
    if (!date || total < 0) return res.status(400).json({ error: 'بيانات الدخل غير صالحة' });
    const timeNow = new Date().toISOString();
    const query = `INSERT INTO daily_income (date, amount, cash_amount, qicard_amount, created_at) VALUES (?, ?, ?, ?, ?) 
                   ON CONFLICT(date) DO UPDATE SET amount = excluded.amount, cash_amount = excluded.cash_amount, qicard_amount = excluded.qicard_amount`;
    db.run(query, [date, total, cash, qicard, timeNow], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('تسجيل دخل', `تسجيل دخل يوم ${date} بإجمالي: ${Number(total).toLocaleString()} د.ع (كاش: ${cash.toLocaleString()} | كي كارد: ${qicard.toLocaleString()})`);
        res.json({ success: true, date, amount: total, cash_amount: cash, qicard_amount: qicard });
    });
});

app.delete('/api/income/:date', (req, res) => {
    const date = req.params.date;
    db.run(`DELETE FROM daily_income WHERE date = ?`, [date], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('حذف دخل', `حذف دخل يوم: ${date}`);
        res.json({ success: true });
    });
});

// --- سجل التدقيق ---
app.get('/api/audit-logs', (req, res) => {
    db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- تحميل نسخة احتياطية ---
app.get('/api/backup-download', (req, res) => {
    if (fs.existsSync(dbFile)) {
        res.download(dbFile, `uruk_pharmacy_manual_backup_${new Date().toISOString().split('T')[0]}.db`);
    } else {
        res.status(404).json({ error: 'ملف قاعدة البيانات غير موجود' });
    }
});

app.listen(PORT, () => {
    console.log(`سيرفر صيدلية أوروك يعمل على البورت: ${PORT}`);
});