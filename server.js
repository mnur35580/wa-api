const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// ================= SETUP UPLOAD FILE (MULTER) =================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_')); }
});
const upload = multer({ storage: storage });

// ================= FIREBASE ADMIN INIT =================
let serviceAccount;
try {
    serviceAccount = require('./firebase-service-account.json');
} catch (e) {
    console.error('❌ ERROR KRITIS: File firebase-service-account.json belum dibuat!');
    process.exit(1); 
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ================= EXPRESS SETUP =================
const app = express();
const port = process.env.PORT || 3005;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= SESSION MANAGER (MULTI DEVICE) =================
// Menyimpan semua instance Baileys yang sedang aktif
const sessions = new Map();

async function startDevice(deviceId, label, apiKey) {
    console.log(`[${deviceId}] 🔄 Memulai sesi untuk: ${label}...`);
    
    const authDir = path.join(__dirname, 'auth_sessions', deviceId);
    if (!fs.existsSync(path.join(__dirname, 'auth_sessions'))) {
        fs.mkdirSync(path.join(__dirname, 'auth_sessions'));
    }
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sessions.set(deviceId, {
        sock: sock,
        qr: null,
        connected: false,
        label: label,
        apiKey: apiKey
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(deviceId);
        if (!session) return;

        if (qr) {
            console.log(`[${deviceId}] 🔄 QR Code baru ter-generate.`);
            session.qr = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            session.connected = false;
            session.qr = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[${deviceId}] ⚠️ Koneksi terputus. Alasan:`, lastDisconnect.error);
            
            if (shouldReconnect) {
                console.log(`[${deviceId}] Mencoba menyambungkan ulang...`);
                setTimeout(() => startDevice(deviceId, label, apiKey), 5000); // Auto reconnect
            } else {
                console.log(`[${deviceId}] ❌ Device ter-logout.`);
                if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                // Restart sesi dari 0 agar langsung mengeluarkan QR Code baru
                setTimeout(() => startDevice(deviceId, label, apiKey), 3000); 
            }
        } else if (connection === 'open') {
            console.log(`[${deviceId}] ✅ Berhasil Terhubung ke WhatsApp!`);
            session.connected = true;
            session.qr = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Fungsi untuk boot up semua device dari database saat server nyala
async function initAllDevices() {
    console.log('🔄 Mengambil data devices dari Firestore...');
    const snapshot = await db.collection('devices').get();
    
    if (snapshot.empty) {
        console.log('ℹ️ Belum ada device yang terdaftar.');
        return;
    }

    snapshot.forEach(doc => {
        const data = doc.data();
        startDevice(doc.id, data.label, data.apiKey);
    });
}

// ================= HELPER FUNCTION =================
function formatWhatsAppNumber(number) {
    let formatted = number;
    if (formatted.endsWith('@g.us')) return formatted;
    if (formatted.includes('-')) return formatted + '@g.us';
    
    if (formatted.startsWith('0')) formatted = '62' + formatted.substring(1);
    if (!formatted.endsWith('@s.whatsapp.net')) formatted = formatted + '@s.whatsapp.net';
    return formatted;
}

// Logger History
async function logMessageHistory(deviceId, target, messageType, status, errorMsg = '') {
    try {
        await db.collection('message_history').add({
            deviceId,
            target,
            messageType,
            status,
            error: errorMsg,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Gagal menyimpan history:', err);
    }
}

// ================= MIDDLEWARE API KEY =================
// Middleware ini WAJIB dipakai di endpoint yang dipakai oleh Klien (Aplikasi Gudang)
async function apiKeyMiddleware(req, res, next) {
    // Klien harus menyertakan Header x-api-key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Header x-api-key tidak ditemukan!' });
    }

    // Cek database apakah API key valid
    const snapshot = await db.collection('devices').where('apiKey', '==', apiKey).get();
    if (snapshot.empty) {
        return res.status(401).json({ error: 'Unauthorized: API Key tidak valid atau tidak terdaftar!' });
    }

    const deviceId = snapshot.docs[0].id;
    const session = sessions.get(deviceId);

    // Pastikan device tersebut sedang konek ke WA
    if (!session || !session.connected) {
        return res.status(400).json({ error: 'Device tidak aktif atau belum terhubung (Scan QR terlebih dahulu).' });
    }

    // Simpan data sock & deviceId ke dalam req agar bisa dipakai di route tujuan
    req.deviceId = deviceId;
    req.sock = session.sock;
    next();
}

// Middleware API Key (Lax) - Mengizinkan akses meskipun belum connect (untuk cek QR)
async function apiKeyLaxMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Unauthorized: Header x-api-key tidak ditemukan!' });

    const snapshot = await db.collection('devices').where('apiKey', '==', apiKey).get();
    if (snapshot.empty) return res.status(401).json({ error: 'Unauthorized: API Key tidak valid!' });

    const deviceId = snapshot.docs[0].id;
    const session = sessions.get(deviceId);
    
    // Walaupun session null atau belum connect, tetap diloloskan
    req.deviceId = deviceId;
    req.sessionData = session; 
    next();
}

// ================= MIDDLEWARE ADMIN AUTH (FIREBASE) =================
async function adminAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Auth Error:', error);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
}

// ================= API ADMIN (DASHBOARD) =================

// Ambil list semua devices
app.get('/api/admin/devices', adminAuthMiddleware, async (req, res) => {
    const snapshot = await db.collection('devices').get();
    const devices = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        const session = sessions.get(doc.id);
        devices.push({
            id: doc.id,
            label: data.label,
            apiKey: data.apiKey,
            connected: session ? session.connected : false,
            qr: (session && !session.connected) ? session.qr : null
        });
    });
    res.json({ success: true, devices });
});

// Tambah device baru
app.post('/api/admin/devices', adminAuthMiddleware, async (req, res) => {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Label wajib diisi!' });

    const deviceId = 'dev_' + Date.now();
    const apiKey = crypto.randomBytes(16).toString('hex'); // Generate random API key (32 karakter rahasia)

    await db.collection('devices').doc(deviceId).set({
        label,
        apiKey,
        createdAt: new Date().toISOString()
    });

    startDevice(deviceId, label, apiKey);
    res.json({ success: true, message: 'Device berhasil ditambahkan!', deviceId, apiKey });
});

// Hapus device
app.delete('/api/admin/devices/:id', adminAuthMiddleware, async (req, res) => {
    const deviceId = req.params.id;
    
    // Hapus dari firestore
    await db.collection('devices').doc(deviceId).delete();
    
    // Matikan session & hapus kredensial
    const session = sessions.get(deviceId);
    if (session) {
        if (session.sock) session.sock.logout(); // Logout dari server WA
        sessions.delete(deviceId);
    }
    
    // Hapus file auth lokal
    const authDir = path.join(__dirname, 'auth_sessions', deviceId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    res.json({ success: true, message: 'Device dihapus!' });
});

// Ambil History (Bisa dibatasi per device nanti)
app.get('/api/admin/history', adminAuthMiddleware, async (req, res) => {
    try {
        const snapshot = await db.collection('message_history').orderBy('timestamp', 'desc').limit(50).get();
        const history = [];
        snapshot.forEach(doc => {
            history.push({ id: doc.id, ...doc.data() });
        });
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ================= API KLIEN (MENGGUNAKAN API KEY) =================

// Endpoint Cek Status & Ambil QR Code
app.get('/api/status', apiKeyLaxMiddleware, async (req, res) => {
    const session = req.sessionData;
    if (!session) {
        return res.json({ connected: false, qr: null, message: "Device sedang booting atau tidak ada di server." });
    }
    res.json({
        connected: session.connected,
        qr: session.connected ? null : session.qr,
        label: session.label
    });
});

// Endpoint Ambil Daftar Grup
app.get('/api/groups', apiKeyMiddleware, async (req, res) => {
    try {
        const groups = await req.sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participantsCount: g.participants.length
        }));
        res.json({ success: true, groups: groupList });
    } catch (err) {
        console.error('Error fetch groups:', err);
        res.status(500).json({ error: 'Gagal mengambil data grup', details: err.message });
    }
});

// Endpoint Logout Klien (Mereset Sesi WA)
app.post('/api/logout', apiKeyMiddleware, async (req, res) => {
    try {
        if (req.sock) {
            await req.sock.logout();
        }
        res.json({ success: true, message: "Berhasil logout dari WhatsApp. Sesi telah direset." });
    } catch (error) {
        console.error('Error logout:', error);
        res.status(500).json({ error: 'Gagal logout', details: error.message });
    }
});

// Endpoint Kirim Teks
app.post('/api/send', apiKeyMiddleware, async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Parameter number dan message wajib diisi!' });

    const formattedNumber = formatWhatsAppNumber(number);

    try {
        await req.sock.sendMessage(formattedNumber, { text: message });
        await logMessageHistory(req.deviceId, formattedNumber, 'text', 'success');
        res.json({ success: true, message: "Pesan teks berhasil dikirim!" });
    } catch (error) {
        await logMessageHistory(req.deviceId, formattedNumber, 'text', 'failed', error.message);
        res.status(500).json({ error: 'Gagal mengirim pesan', details: error.message });
    }
});

// Endpoint Kirim Media dengan Upload File Lokal
app.post('/api/send-media', upload.single('file'), apiKeyMiddleware, async (req, res) => {
    const { number, type, caption } = req.body;
    const file = req.file;

    if (!number || !type || !file) {
        if (file) fs.unlinkSync(file.path); 
        return res.status(400).json({ error: 'Parameter number, type, dan file wajib diisi!' });
    }

    const formattedNumber = formatWhatsAppNumber(number);
    let messageOptions = {};
    const filePath = file.path;

    try {
        if (type === 'image') {
            messageOptions = { image: { url: filePath }, caption: caption || '' };
        } else if (type === 'video') {
            messageOptions = { video: { url: filePath }, caption: caption || '' };
        } else if (type === 'document') {
            messageOptions = { 
                document: { url: filePath }, 
                mimetype: file.mimetype,
                fileName: file.originalname,
                caption: caption || ''
            };
        } else {
            fs.unlinkSync(filePath);
            return res.status(400).json({ error: 'Type tidak valid!' });
        }

        await req.sock.sendMessage(formattedNumber, messageOptions);
        
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await logMessageHistory(req.deviceId, formattedNumber, 'media', 'success');

        res.json({ success: true, message: "Media berhasil dikirim!" });
    } catch (error) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await logMessageHistory(req.deviceId, formattedNumber, 'media', 'failed', error.message);
        console.error('Error send media:', error);
        res.status(500).json({ error: 'Gagal mengirim media', details: error.message });
    }
});

// Jalankan Server
app.listen(port, () => {
    console.log(`🚀 SaaS API Server Berjalan di port ${port}`);
    console.log(`➡️  Buka http://localhost:${port} di browser.`);
    initAllDevices(); 
});
