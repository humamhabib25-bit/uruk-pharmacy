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

        db.run(`CREATE TABLE IF NOT EXISTS expense_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            main_type TEXT NOT NULL,
            name TEXT NOT NULL,
            is_custom INTEGER DEFAULT 0,
            UNIQUE(main_type, name)
        )`);

        db.get(`SELECT count(*) as count FROM expense_categories`, [], (err, row) => {
            if (!err && row && row.count === 0) {
                const defaultCats = [
                    ['تشغيلية', 'رواتب كوادر وصيادلة', 0],
                    ['تشغيلية', 'إيجار الصيدلية', 0],
                    ['تشغيلية', 'كهرباء ومولدات', 0],
                    ['تشغيلية', 'نثريات ومستلزمات صيدلية', 0],
                    ['تشغيلية', 'صيانة وتبريد وتجهيزات', 0],
                    ['عامة', 'ضيافة ونظافة', 0],
                    ['عامة', 'تسويق ودعاية', 0],
                    ['عامة', 'رسوم وتجديد نقابة وضريبة', 0],
                    ['عامة', 'سحوبات شخصية', 0],
                    ['عامة', 'مصاريف نثرية عامة', 0],
                    ['عامة', 'أخرى', 0]
                ];
                const stmt = db.prepare("INSERT OR IGNORE INTO expense_categories (main_type, name, is_custom) VALUES (?, ?, ?)");
                defaultCats.forEach(c => stmt.run(c));
                stmt.finalize();
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            main_type TEXT NOT NULL,
            category_name TEXT NOT NULL,
            sub_category TEXT DEFAULT '',
            amount REAL NOT NULL,
            payment_method TEXT DEFAULT 'كاش',
            recipient TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT ''
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            role TEXT DEFAULT 'صيدلي',
            base_salary REAL NOT NULL DEFAULT 0,
            phone TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT ''
        )`);

        db.get(`SELECT count(*) as count FROM employees`, [], (err, row) => {
            if (!err && row && row.count === 0) {
                const timeNow = new Date().toISOString();
                const sampleEmps = [
                    ['د. علي الموسوي', 'صيدلي ممارس', 1200000, '07701234567', 1, timeNow],
                    ['أحمد كريم', 'مساعد صيدلي', 750000, '07801234567', 1, timeNow],
                    ['سجاد حيدر', 'خدمات ونظافة', 400000, '07501234567', 1, timeNow]
                ];
                const stmt = db.prepare("INSERT INTO employees (name, role, base_salary, phone, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)");
                sampleEmps.forEach(e => stmt.run(e));
                stmt.finalize();
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS employee_salary_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            month TEXT NOT NULL,
            payment_date TEXT NOT NULL,
            base_salary REAL NOT NULL,
            deduction_amount REAL DEFAULT 0,
            deduction_reason TEXT DEFAULT '',
            paid_amount REAL NOT NULL,
            payment_method TEXT DEFAULT 'كاش',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT '',
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
            UNIQUE(employee_id, month)
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

// --- إدارة الصرفيات والمصاريف ---
app.get('/api/expense-categories', (req, res) => {
    db.all(`SELECT * FROM expense_categories ORDER BY id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expense-categories', (req, res) => {
    const { main_type, name } = req.body;
    const nameClean = (name || '').trim();
    if (!nameClean) return res.status(400).json({ error: 'اسم التصنيف لا يمكن أن يكون فارغاً' });
    db.run(`INSERT INTO expense_categories (main_type, name, is_custom) VALUES (?, ?, 1)`, [main_type, nameClean], function(err) {
        if (err) return res.status(400).json({ error: 'التصنيف موجود مسبقاً أو غير صالح' });
        logAudit('إضافة تصنيف صرفيات', `إضافة تصنيف جديد: ${nameClean} ضمن قسم ${main_type}`);
        res.json({ success: true, id: this.lastID, main_type, name: nameClean });
    });
});

app.delete('/api/expense-categories/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM expense_categories WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('حذف تصنيف صرفيات', `حذف تصنيف رقم: ${id}`);
        res.json({ success: true });
    });
});

app.get('/api/expenses', (req, res) => {
    const { month, main_type } = req.query;
    let query = `SELECT * FROM expenses WHERE 1=1`;
    const params = [];
    if (month) {
        query += ` AND date LIKE ?`;
        params.push(`${month}%`);
    }
    if (main_type && main_type !== 'all') {
        query += ` AND main_type = ?`;
        params.push(main_type);
    }
    query += ` ORDER BY date DESC, id DESC`;
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expenses', (req, res) => {
    const { date, main_type, category_name, sub_category, amount, payment_method, recipient, notes } = req.body;
    const amt = parseFloat(amount || 0);
    if (!date || amt <= 0) return res.status(400).json({ error: 'بيانات الصرفية غير صالحة' });
    const timeNow = new Date().toISOString();
    const payMethod = payment_method || 'كاش';
    db.run(`INSERT INTO expenses (date, main_type, category_name, sub_category, amount, payment_method, recipient, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [date, main_type, category_name, sub_category || '', amt, payMethod, recipient || '', notes || '', timeNow],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit('تسجيل صرفية', `تسجيل صرفية ${main_type} (${category_name}) بمبلغ ${amt.toLocaleString()} د.ع (${payMethod})`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/expenses/:id', (req, res) => {
    const id = req.params.id;
    const { date, main_type, category_name, sub_category, amount, payment_method, recipient, notes } = req.body;
    const amt = parseFloat(amount || 0);
    db.run(`UPDATE expenses SET date = ?, main_type = ?, category_name = ?, sub_category = ?, amount = ?, payment_method = ?, recipient = ?, notes = ? WHERE id = ?`,
        [date, main_type, category_name, sub_category || '', amt, payment_method || 'كاش', recipient || '', notes || '', id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit('تعديل صرفية', `تعديل صرفية رقم #${id} (${category_name}) بمبلغ ${amt.toLocaleString()} د.ع`);
            res.json({ success: true });
        }
    );
});

app.delete('/api/expenses/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM expenses WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('حذف صرفية', `حذف صرفية رقم #${id}`);
        res.json({ success: true });
    });
});

// --- إدارة الموظفين والرواتب ---
app.get('/api/employees', (req, res) => {
    db.all(`SELECT * FROM employees ORDER BY id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/employees', (req, res) => {
    const { name, role, base_salary, phone } = req.body;
    const nameClean = (name || '').trim();
    if (!nameClean) return res.status(400).json({ error: 'اسم الموظف لا يمكن أن يكون فارغاً' });
    const timeNow = new Date().toISOString();
    db.run(`INSERT INTO employees (name, role, base_salary, phone, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
        [nameClean, role || 'صيدلي', parseFloat(base_salary || 0), phone || '', timeNow],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit('إضافة موظف', `إضافة الموظف: ${nameClean} براتب مرجعي: ${Number(base_salary).toLocaleString()} د.ع`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/employees/:id', (req, res) => {
    const id = req.params.id;
    const { name, role, base_salary, phone } = req.body;
    const nameClean = (name || '').trim();
    db.run(`UPDATE employees SET name = ?, role = ?, base_salary = ?, phone = ? WHERE id = ?`,
        [nameClean, role || 'صيدلي', parseFloat(base_salary || 0), phone || '', id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit('تعديل موظف', `تعديل بيانات الموظف: ${nameClean}`);
            res.json({ success: true });
        }
    );
});

app.delete('/api/employees/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM employees WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('حذف موظف', `حذف موظف رقم: ${id}`);
        res.json({ success: true });
    });
});

app.get('/api/salary-payments', (req, res) => {
    const { month } = req.query;
    let query = `
        SELECT p.*, e.name as employee_name, e.role as employee_role
        FROM employee_salary_payments p
        JOIN employees e ON p.employee_id = e.id
        WHERE 1=1
    `;
    const params = [];
    if (month) {
        query += ` AND p.month = ?`;
        params.push(month);
    }
    query += ` ORDER BY p.payment_date DESC, p.id DESC`;
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/salary-payments', (req, res) => {
    const { employee_id, month, payment_date, base_salary, deduction_amount, deduction_reason, paid_amount, payment_method, notes } = req.body;
    const timeNow = new Date().toISOString();
    const query = `
        INSERT INTO employee_salary_payments 
            (employee_id, month, payment_date, base_salary, deduction_amount, deduction_reason, paid_amount, payment_method, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(employee_id, month) DO UPDATE SET
            payment_date = excluded.payment_date,
            base_salary = excluded.base_salary,
            deduction_amount = excluded.deduction_amount,
            deduction_reason = excluded.deduction_reason,
            paid_amount = excluded.paid_amount,
            payment_method = excluded.payment_method,
            notes = excluded.notes
    `;
    db.run(query, [employee_id, month, payment_date, base_salary, deduction_amount || 0, deduction_reason || '', paid_amount, payment_method || 'كاش', notes || '', timeNow], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('صرف راتب', `صرف راتب شهر ${month} لموظف #${employee_id} بمبلغ: ${Number(paid_amount).toLocaleString()} د.ع`);
        res.json({ success: true });
    });
});

app.delete('/api/salary-payments/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM employee_salary_payments WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit('إلغاء صرف راتب', `إلغاء صرف راتب رقم #${id}`);
        res.json({ success: true });
    });
});

app.get('/api/financial-summary', (req, res) => {
    const { month } = req.query;
    let incQ = `SELECT COALESCE(SUM(amount), 0) AS total_income, COALESCE(SUM(cash_amount), 0) AS cash_income, COALESCE(SUM(qicard_amount), 0) AS qicard_income FROM daily_income`;
    let incParams = [];
    if (month) {
        incQ += ` WHERE date LIKE ?`;
        incParams.push(`${month}%`);
    }

    db.get(incQ, incParams, (err, incRow) => {
        const total_income = incRow ? incRow.total_income : 0;
        const cash_income = incRow ? incRow.cash_income : 0;
        const qicard_income = incRow ? incRow.qicard_income : 0;

        let expQ = `SELECT main_type, payment_method, COALESCE(SUM(amount), 0) as total FROM expenses`;
        let expParams = [];
        if (month) {
            expQ += ` WHERE date LIKE ?`;
            expParams.push(`${month}%`);
        }
        expQ += ` GROUP BY main_type, payment_method`;

        db.all(expQ, expParams, (err, expRows) => {
            let operational_expenses = 0;
            let general_expenses = 0;
            let expenses_cash = 0;
            let expenses_qicard = 0;

            (expRows || []).forEach(r => {
                const amt = r.total || 0;
                if (r.main_type === 'تشغيلية') operational_expenses += amt;
                else general_expenses += amt;
                if (r.payment_method === 'كي كارد') expenses_qicard += amt;
                else expenses_cash += amt;
            });

            // رواتب الموظفين (ضمن الصرفيات التشغيلية)
            let salQ = `SELECT payment_method, COALESCE(SUM(paid_amount), 0) as total FROM employee_salary_payments`;
            let salParams = [];
            if (month) {
                salQ += ` WHERE month = ?`;
                salParams.push(month);
            }
            salQ += ` GROUP BY payment_method`;

            db.all(salQ, salParams, (err, salRows) => {
                let total_salaries_paid = 0;
                (salRows || []).forEach(s => {
                    const amt = s.total || 0;
                    total_salaries_paid += amt;
                    operational_expenses += amt;
                    if (s.payment_method === 'كي كارد') expenses_qicard += amt;
                    else expenses_cash += amt;
                });

                const total_direct_expenses = operational_expenses + general_expenses;

                let supQ = `SELECT COALESCE(SUM(payment_amount), 0) as total_supplier_pays, COALESCE(SUM(discount_amount), 0) as total_discounts FROM supplier_transactions`;
                let supParams = [];
                if (month) {
                    supQ += ` WHERE date LIKE ?`;
                    supParams.push(`${month}%`);
                }

                db.get(supQ, supParams, (err, supRow) => {
                    const total_supplier_pays = supRow ? supRow.total_supplier_pays : 0;
                    const total_supplier_discounts = supRow ? supRow.total_discounts : 0;
                    const total_outflow = total_direct_expenses + total_supplier_pays;
                    const net_profit = total_income - total_outflow;

                    res.json({
                        month: month || 'all',
                        total_income,
                        cash_income,
                        qicard_income,
                        operational_expenses,
                        general_expenses,
                        total_salaries_paid,
                        total_direct_expenses,
                        expenses_cash,
                        expenses_qicard,
                        total_supplier_pays,
                        total_supplier_discounts,
                        total_outflow,
                        net_profit
                    });
                });
            });
        });
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