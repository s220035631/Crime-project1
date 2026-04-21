require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'crime_system'
});

db.connect((err) => {
    if (err) {
        console.log('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Connected to MySQL');
    }
});

// ====== Auth ======
app.post('/api/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.query(
        'INSERT INTO USER (username, email, password, role) VALUES (?,?,?,?)',
        [username, email, hashed, role],
        (err) => {
            if (err) return res.status(400).json({ error: 'Email already exists' });
            res.json({ message: 'User created successfully' });
        }
    );
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM USER WHERE email = ?', [email], async (err, results) => {
        if (!results || !results.length) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ user_id: user.user_id, role: user.role }, 'SECRET_KEY');
        db.query('INSERT INTO LOGS (user_id, action) VALUES (?, ?)', [user.user_id, 'LOGIN']);
        res.json({ token, role: user.role, name: user.username });
    });
});

app.post('/api/logout', (req, res) => {
    const { user_id } = req.body;
    db.query('INSERT INTO LOGS (user_id, action) VALUES (?, ?)', [user_id, 'LOGOUT']);
    res.json({ message: 'Logged out' });
});

// ====== Users API ======
app.get('/api/users', (req, res) => {
    db.query('SELECT user_id, username, email, role, created_at FROM USER', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.put('/api/users/:id', (req, res) => {
    const { username, email, role } = req.body;
    db.query(
        'UPDATE USER SET username=?, email=?, role=? WHERE user_id=?',
        [username, email, role, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'User updated successfully' });
        }
    );
});

app.delete('/api/users/:id', (req, res) => {
    db.query('DELETE FROM USER WHERE user_id=?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'User deleted successfully' });
    });
});

// ====== Logs API ======
app.get('/api/logs', (req, res) => {
    db.query(
        `SELECT l.log_id, u.username, l.action, l.log_time 
         FROM LOGS l LEFT JOIN USER u ON l.user_id = u.user_id 
         ORDER BY l.log_time DESC`,
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results);
        }
    );
});

// ====== Alerts API ======
app.get('/api/alerts', (req, res) => {
    db.query('SELECT * FROM ALERTS ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.put('/api/alerts/:id', (req, res) => {
    db.query(
        'UPDATE ALERTS SET status="read" WHERE alert_id=?',
        [req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Alert marked as read' });
        }
    );
});

// ====== Data Upload API ======
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = ['.csv', '.xlsx', '.xls'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only CSV and Excel files allowed'));
    }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const userId = req.body.user_id || 1;
    let rows = [];

    try {
        if (ext === '.csv') {
            fs.createReadStream(filePath)
                .pipe(csvParser())
                .on('data', (row) => rows.push(row))
                .on('end', () => {
                    db.query('INSERT INTO UPLOADED_FILES (user_id, file_name, file_path) VALUES (?,?,?)',
                        [userId, req.file.originalname, req.file.filename]);
                    db.query('INSERT INTO LOGS (user_id, action) VALUES (?, ?)', [userId, 'UPLOAD']);
                    res.json({ message: `✅ Uploaded ${rows.length} rows`, rows: rows.length });
                });
        } else {
            const workbook = XLSX.readFile(filePath);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(sheet);
            db.query('INSERT INTO UPLOADED_FILES (user_id, file_name, file_path) VALUES (?,?,?)',
                [userId, req.file.originalname, req.file.filename]);
            db.query('INSERT INTO LOGS (user_id, action) VALUES (?, ?)', [userId, 'UPLOAD']);
            res.json({ message: `✅ Uploaded ${rows.length} rows`, rows: rows.length });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files', (req, res) => {
    db.query(
        `SELECT f.file_id, u.username, f.file_name, f.upload_date 
         FROM UPLOADED_FILES f LEFT JOIN USER u ON f.user_id = u.user_id 
         ORDER BY f.upload_date DESC`,
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results);
        }
    );
});

app.get('/api/latest-data', (req, res) => {
    return res.status(404).json({ error: 'No files uploaded yet' });
    db.query(
        'SELECT * FROM UPLOADED_FILES ORDER BY upload_date DESC LIMIT 1',
        (err, results) => {
            if (err || !results.length) {
                return res.status(404).json({ error: 'No files uploaded yet' });
            }
            const filePath = path.join(__dirname, 'uploads', results[0].file_path);
            const ext = path.extname(results[0].file_name).toLowerCase();
            try {
                if (ext === '.csv') {
                    let rows = [];
                    fs.createReadStream(filePath)
                        .pipe(csvParser())
                        .on('data', row => rows.push(row))
                        .on('end', () => res.json(rows));
                } else {
                    const workbook = XLSX.readFile(filePath);
                    const sheet = workbook.Sheets[workbook.SheetNames[0]];
                    const rows = XLSX.utils.sheet_to_json(sheet);
                    res.json(rows);
                }
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        }
    );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
